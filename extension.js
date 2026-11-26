'use strict';
const vscode=require('vscode');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {Document,atomicFile}=require('./lib/document');
const {gzip}=require('node:zlib');
const {promisify}=require('node:util');
const {create,validateState,clipThumb,clipBytes,clipEntityPreview,clipHeadProfiles}=require('./lib/nbt');
const {jarFolder,jarMaskData,readJarVersion}=require('./lib/assets');
const {clientVersions,matchingClientVersion,upgradeVersions,isCachedClient}=require('./lib/mojang');
const {installOfficialClient,officialJarPath,dependenciesInstalled}=require('./lib/mojang-install');
const {collisionShapes,gameClasspath,prepareSummon,stopSummon,summonEntity}=require('./lib/native-summon');
const {entityModels}=require('./lib/mask-java');
const {addHint,librariesRoots}=require('./lib/paths');
const {playerSkin}=require('./lib/player-skins');
const manifest=require('./package.json');
const VIEW='voxelNbt.structure';
const BRUSH_PRESETS='voxel.brushPresets';
const builtinBrushPresets=[['空气','air'],['石头','stone'],['草方块','grass_block']].map(([label,name])=>({label,state:{name:`minecraft:${name}`,props:{}}}));
const uriCheck=uri=>{if(uri?.scheme!=='file')throw new Error('请使用本地文件或远程 VS Code 主机上的文件。');return uri.fsPath;};
function cancel(token){if(token?.isCancellationRequested)throw new vscode.CancellationError();}
class Provider{
  constructor(context){this.context=context;this.panels=new Set();this.templates=new Map();this.templateCounter=0;this.officialInstalls=new Map();this.changes=new vscode.EventEmitter();this.onDidChangeCustomDocument=this.changes.event;}
  prefs(){const prefs=this.context.globalState.get('voxel.prefs',{});return prefs.resource?.kind==='folder'?{...prefs,resource:undefined}:prefs;}
  resource(doc){return doc?.resource??this.prefs().resource;}
  showPrefs(p){p.panel.webview.postMessage({type:'prefs',prefs:{...this.prefs(),resource:this.resource(p.doc)}});}
  showBrushPresets(p){p.panel.webview.postMessage({type:'brushPresets',builtin:builtinBrushPresets,custom:this.context.globalState.get(BRUSH_PRESETS,[])});}
  async saveBrushPreset(raw){
    const state=validateState(raw),store=this.context.globalState;
    if(state.name==='minecraft:structure_void')throw new Error('结构空位不能保存为画笔预设。');
    const validateInput=value=>{
      const label=value.trim();
      if(!label||label.length>40)return '请输入 1–40 个字符的预设名称。';
      if([...builtinBrushPresets,...store.get(BRUSH_PRESETS,[])].some(p=>p.label.toLowerCase()===label.toLowerCase()))return '这个名称已被使用。';
    };
    const input=await vscode.window.showInputBox({title:'保存画笔预设',prompt:'当前方块及其状态将保存在本机，可在其他结构中使用。',validateInput});
    if(input===undefined)return;
    const error=validateInput(input);if(error)throw new Error(error);
    await store.update(BRUSH_PRESETS,[...store.get(BRUSH_PRESETS,[]),{label:input.trim(),state}]);
    for(const pane of this.panels)if(pane.active)this.showBrushPresets(pane);
  }
  async deleteBrushPreset(label){
    if(typeof label!=='string')return;
    const store=this.context.globalState,presets=store.get(BRUSH_PRESETS,[]),remaining=presets.filter(p=>p.label!==label);
    if(remaining.length===presets.length)return;
    await store.update(BRUSH_PRESETS,remaining);
    for(const pane of this.panels)if(pane.active)this.showBrushPresets(pane);
  }
  async maskSource(doc){
    const src=this.resource(doc);if(src?.kind!=='jar')return null;
    const st=await fs.stat(src.path),key=src.path+'|'+st.size+'|'+st.mtimeMs;
    if(this.maskCache?.key!==key){
      const data=Promise.all([jarMaskData(src.path),collisionShapes(src.path).catch(()=>null)]).then(([raw,game])=>({...raw,traits:game?.traits??null}));
      this.maskCache={key,data};data.catch(()=>{if(this.maskCache?.key===key)this.maskCache=null;});
    }
    return {key,jar:src.path,catalog:await this.maskCache.data};
  }
  async documentMasks(doc){
    const pack=await this.maskSource(doc);if(!pack)throw new Error('方块掩码需要在设置里选择原版客户端 JAR');
    if(doc.maskPack?.key!==pack.key){
      const data=doc.call('maskCatalog',pack.catalog,pack.jar,librariesRoots(pack.jar)).then(legacy=>legacy?{...pack.catalog,legacy}:pack.catalog);
      doc.maskPack={key:pack.key,data};data.catch(()=>{if(doc.maskPack?.data===data)doc.maskPack=null;});
    }
    return doc.maskPack.data;
  }
  async showMasks(doc,p){
    const source=this.resource(doc),generation=p.generation;
    if(source?.kind!=='jar')return;
    try{const catalog=await this.documentMasks(doc);if(p.alive&&p.generation===generation&&this.resource(doc)?.path===source.path)p.panel.webview.postMessage({type:'maskCatalog',catalog});}
    catch(e){if(p.alive&&p.generation===generation)p.panel.webview.postMessage({type:'maskCatalog',error:e.message});}
  }
  async assets(src){
    if(src?.kind!=='jar')return null;
    const cache=await jarFolder(src.path,this.context.globalStorageUri.fsPath);
    return vscode.Uri.file(cache);
  }
  async loadWebview(p,initial=false){
    const web=p.panel.webview,src=this.resource(p.doc);let assets;
    try{if(!initial)assets=await this.assets(src);}catch(e){if(src?.path)void vscode.window.showWarningMessage('Voxel NBT Studio: '+e.message);}
    if(!p.alive||this.resource(p.doc)?.path!==src?.path)return;
    p.jarPath=initial?undefined:src?.path;p.assetsLoaded=Boolean(assets);
    web.options={enableScripts:true,localResourceRoots:[p.media,...(assets?[assets]:[])]};
    const res=name=>web.asWebviewUri(vscode.Uri.joinPath(p.media,name)).toString();
    p.active=false;p.generation=(p.generation??0)+1;
    web.html=p.template.replaceAll('__CSP__',web.cspSource).replaceAll('__CSS__',res('style.css')).replaceAll('__APP__',res('editor.js')).replaceAll('__WORKER__',res('mesh.js')).replaceAll('__ASSETS__',assets?web.asWebviewUri(assets).toString().replaceAll('&','&amp;').replaceAll('"','&quot;'):'');
  }
  officialJarPath(version){return officialJarPath(this.context.globalStorageUri.fsPath,version);}
  async cachedJar(dv){
    const version=matchingClientVersion(dv);
    if(version){const file=this.officialJarPath(version);if(await isCachedClient(dv,file))return file;}
  }
  async downloadJar(version){
    const location=vscode.ProgressLocation.Notification;
    if(!version){
      const versions=await vscode.window.withProgress({location,title:'Voxel NBT Studio：读取 Mojang 正式版清单…'},clientVersions);
      if(!versions.length)throw new Error('未找到受支持的 Minecraft 正式版。');
      version=await vscode.window.showQuickPick(versions,{title:'下载 Minecraft 客户端 JAR',placeHolder:'选择 Java 版 1.21–26.3 正式版'});
      if(!version)return;
    }
    return this.installJar(version);
  }
  installJar(version){
    if(this.officialInstalls.has(version))return this.officialInstalls.get(version);
    const storage=this.context.globalStorageUri.fsPath;
    const task=vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`Voxel NBT Studio：准备 Minecraft ${version} JAR 和依赖…`,cancellable:true},async(progress,token)=>{
      const controller=new AbortController(),listener=token.onCancellationRequested(()=>controller.abort());
      try{
        if(token.isCancellationRequested)return;
        const file=await installOfficialClient(storage,version,controller.signal,value=>progress.report(value));
        if(token.isCancellationRequested)return;
        await jarFolder(file,storage);
        if(!token.isCancellationRequested)return file;
      }catch(e){if(!token.isCancellationRequested)throw e;}
      finally{listener.dispose();}
    });
    const result=Promise.resolve(task).finally(()=>this.officialInstalls.delete(version));
    this.officialInstalls.set(version,result);
    return result;
  }
  async repairOfficialJar(version,file){
    if(typeof version!=='string'||!file||!this.context.globalStorageUri||file!==this.officialJarPath(version)||await dependenciesInstalled(file))return true;
    return Boolean(await this.installJar(version));
  }
  async prefEvent(p,m){
    if(m.type==='dismissMaterialIntro'){
      if(!this.prefs().materialIntroSeen)await this.context.globalState.update('voxel.prefs',{...this.prefs(),materialIntroSeen:true});
      for(const pane of this.panels)if(pane.active)this.showPrefs(pane);return;
    }
    if(m.type==='rendering'){
      const prefs=this.prefs(),{mode,gamma}=m;
      if(!['smooth','game'].includes(mode)||!Number.isFinite(gamma)||gamma<0||gamma>1)throw new Error('渲染模式或 Gamma 值无效');
      if(mode==='game'&&this.resource(p?.doc)?.kind!=='jar')throw new Error('游戏风格仅在选择原版客户端 JAR 时可用');
      await this.context.globalState.update('voxel.prefs',{...prefs,rendering:{mode,gamma}});
      for(const pane of this.panels)this.showPrefs(pane);return;
    }
    if(m.type==='navigation'){
      if(!['blender','blockbench'].includes(m.preset))throw new Error('未知的鼠标预设');
      await this.context.globalState.update('voxel.prefs',{...this.prefs(),navigation:m.preset});for(const pane of this.panels)this.showPrefs(pane);return;
    }
    if(m.type==='shortcut'){
      const key=m.key, action=m.action;if(!manifest.contributes.commands.some(c=>c.command==='voxelNbt.'+action)||['open','create'].includes(action)||!(key===null||typeof key==='string'&&key.length<=42&&!/[\r\n]/.test(key)))throw new Error('无效的快捷键');
      const prefs=this.prefs(),keys={...prefs.keys,[action]:key};
      for(const k of Object.keys(keys))if(k!==action&&key&&keys[k]===key)keys[k]=null;
      await this.context.globalState.update('voxel.prefs',{...prefs,keys});for(const pane of this.panels)this.showPrefs(pane);return;
    }
    if(m.type==='resetKeys'){const prefs=this.prefs();await this.context.globalState.update('voxel.prefs',{...prefs,keys:{}});for(const pane of this.panels)this.showPrefs(pane);return;}
    if(!['jar','download','none'].includes(m.kind)||this.downloadingJar)return;
    const src={kind:m.kind==='download'?'jar':m.kind};
    if(m.kind==='download'){
      this.downloadingJar=true;
      try{src.path=await this.downloadJar();}finally{this.downloadingJar=false;}
      if(!src.path)return;
    }else if(m.kind==='jar'){
      const [uri]=await vscode.window.showOpenDialog({canSelectMany:false,canSelectFolders:false,canSelectFiles:true,openLabel:'选择 Minecraft 客户端 JAR',filters:{'Minecraft 客户端':['jar']}})||[];
      if(!uri)return;src.path=uriCheck(uri);
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Voxel NBT Studio：验证资源…'},()=>jarFolder(src.path,this.context.globalStorageUri.fsPath));
    }
    await this.useResource(src);
  }
  async useResource(resource){
    void stopSummon();
    if(resource.kind==='jar')addHint(path.dirname(resource.path));
    await this.context.globalState.update('voxel.prefs',{...this.prefs(),resource});
    for(const pane of this.panels){pane.doc.resource=undefined;pane.doc.loadNotice=null;}
    await Promise.all([...this.panels].map(pane=>this.loadWebview(pane)));
  }
  showTemplates(p){p.panel.webview.postMessage({type:'templates',items:[...this.templates.values()].reverse().map(({meta})=>meta)});}
  async showCollisionShapes(doc,p){
    const src=this.resource(doc),generation=p.generation;
    if(src?.kind!=='jar'){await doc.call('gameCatalog',null).catch(()=>{});return;}
    const send=m=>{if(p.alive&&p.generation===generation&&this.resource(doc)?.path===src.path)p.panel.webview.postMessage({type:'collisionShapes',...m});};
    try{
      const {blocks,shapes,schema,tiles,turns,dataVersion,version}=await collisionShapes(src.path);
      if(this.resource(doc)?.path!==src.path||!p.alive||p.generation!==generation)return;
      await doc.call('gameCatalog',{schema,tiles,turns,dataVersion});
      send({catalog:{blocks,shapes,schema,tiles,dataVersion,version}});
    }catch(e){if(p.alive&&p.generation===generation&&this.resource(doc)?.path===src.path)await doc.call('gameCatalog',null).catch(()=>{});send({error:e.message});}
  }
  async showEntityModels(p){
    const src=this.resource(p.doc),generation=p.generation;
    if(src?.kind!=='jar')return;
    try{const data=await entityModels(src.path);if(p.alive&&p.generation===generation)p.panel.webview.postMessage({type:'entityModels',data});}
    catch(e){if(p.alive&&p.generation===generation)p.panel.webview.postMessage({type:'entityModels',error:`实体模型未加载：${e.message.split(/\r?\n/)[0].slice(0,220)}`});}
  }
  storeTemplate(p,clip){
    const bytes=[...this.templates.values()].reduce((n,t)=>n+t.clip.bytes,0);
    if(this.templates.size>=16||bytes+clip.bytes>48*1024*1024)throw new Error('临时模板列表已满，请先移除不用的模板');
    const id=++this.templateCounter,meta={id,name:clip.entityOnly?`实体 · ${clip.entityId}`:`模板 ${id}`,...clipThumb(clip),entityOnly:clip.entityOnly===true,entityCount:clip.entities?.length??0};
    this.templates.set(id,{clip,meta});for(const pane of this.panels)if(pane.active)this.showTemplates(pane);
    p.panel.webview.postMessage({type:'copied',id});
  }
  command(cmd){for(const p of this.panels)if(p.panel.active)p.panel.webview.postMessage({type:'command',cmd});}
  openCustomDocument(uri,context){
    const file=uriCheck(uri),backup=context.backupId?uriCheck(vscode.Uri.parse(context.backupId)):null;
    return new Document(uri,file,backup);
  }
  async closeUnloaded(doc,destination){
    const tabs=vscode.window.tabGroups.all.flatMap(g=>g.tabs).filter(({input})=>input instanceof vscode.TabInputCustom&&input.viewType===VIEW&&input.uri.toString()===doc.uri.toString());
    if(tabs.length)await vscode.window.tabGroups.close(tabs,true);
    if(destination)await vscode.commands.executeCommand('vscode.openWith',vscode.Uri.file(destination),VIEW);
  }
  async checkUpgrade(doc){
    if(doc.openBlocked)return false;
    doc.matchedJar=null;
    const src=this.resource(doc);
    if(src?.kind==='none')return true;
    const [from,version]=await Promise.all([doc.call('dataVersion'),src?.kind==='jar'?readJarVersion(src.path).catch(()=>null):null]);
    const to=version?.world_version;
    if(!Number.isInteger(from))return true;
    if(from===to){doc.matchedJar=version.id||version.name||to;return true;}
    const canWrite=()=>{const current=this.resource(doc);return doc.panels.size>0&&current?.kind===src?.kind&&current?.path===src?.path;};
    const cached=await this.cachedJar(from);
    if(!canWrite())return false;
    const match=matchingClientVersion(from);
    if(cached){doc.resource={kind:'jar',path:cached};doc.matchedJar=match;return true;}
    if(src?.kind!=='jar')return true;
    const protectEdits=doc.hasEdits||doc.recovered,canUpgrade=Number.isInteger(to)&&from<to&&!protectEdits;
    const label=String(version?.id||version?.name||to||'未知版本').replace(/[^a-zA-Z0-9._-]/g,'_');
    const {dir,name}=path.parse(doc.file),copy=path.join(dir,`${name}_${label}.nbt`);
    const auto=match?{title:`自动选用 ${match}（官方源）`}:null,color={title:'用色块加载',isCloseAffordance:Boolean(protectEdits)};
    const options=[...(canUpgrade?[{title:'创建副本后更新'},{title:'更新'}]:[]),...(auto?[auto]:[]),color,...(protectEdits?[]:[{title:'不加载',isCloseAffordance:true}])];
    const detail=`结构 DataVersion：${from}；所选 JAR：${Number.isInteger(to)?`${label}（${to}）`:'无法读取版本'}。`
      +(canUpgrade?`\n\n创建副本会保留原件，并打开同目录的 ${path.basename(copy)}；直接更新会覆盖原文件。`:'')
      +(match?`\n\n可从官方源下载 ${match} 并用于此结构，不会修改 NBT。`:'');
    let chosen,feedback='';
    while(canWrite()){
      chosen=await vscode.window.showWarningMessage(`“${path.basename(doc.file)}”与所选 JAR 版本不匹配`,{modal:true,detail:detail+feedback},...options);
      if(!canWrite())return false;
      if(chosen?.title===color.title||(!chosen&&protectEdits)){doc.resource={kind:'none'};return true;}
      if(!auto||chosen?.title!==auto.title)break;
      if(this.downloadingJar){feedback='\n\n已有官方 JAR 正在下载，请稍后重试。';continue;}
      this.downloadingJar=true;
      try{
        const file=await this.downloadJar(match);
        if(!canWrite())return false;
        if(file){
          const selected=await readJarVersion(file);
          if(selected.id!==match||selected.world_version!==from)throw new Error('JAR 的 DataVersion 与结构不符');
          if(!canWrite())return false;
          doc.resource={kind:'jar',path:file};doc.matchedJar=match;return true;
        }
        feedback='\n\n已取消下载，未修改 NBT。';
      }catch(e){feedback=`\n\n无法选用官方 JAR：${e.message}`;}
      finally{this.downloadingJar=false;}
    }
    if(!canWrite())return false;
    let destination;
    if(canUpgrade&&(chosen?.title==='创建副本后更新'||chosen?.title==='更新')){
      destination=chosen.title==='创建副本后更新'?copy:undefined;
      if(!await this.writeUpgrade(doc,src.path,{label,dv:to},destination,canWrite))return false;
      if(!destination){doc.matchedJar=version.id||version.name||to;return true;}
    }
    doc.openBlocked=true;
    void this.closeUnloaded(doc,destination).catch(e=>vscode.window.showErrorMessage(e.message));
    return false;
  }
  async writeUpgrade(doc,jar,target,destination,canWrite){
    if(!await this.repairOfficialJar(target.label,jar)||!canWrite())return false;
    try{
      return await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`Voxel NBT Studio：正在升级结构至 ${target.label}…`},
        ()=>doc.upgrade(jar,target.dv,destination,canWrite));
    }catch(e){
      if(e.code==='EEXIST'&&destination)throw new Error(`副本 ${path.basename(destination)} 已存在，未覆盖任何文件。`);
      throw e;
    }
  }
  async upgradeStructure(doc,p){
    const from=await doc.call('dataVersion');
    if(!Number.isInteger(from))throw new Error('当前结构缺少有效的 DataVersion，无法安全升级。');
    const versions=upgradeVersions(from);
    if(!versions.length)throw new Error('没有比当前结构更新的受支持正式版。');
    const generation=p.generation,canWrite=()=>p.alive&&p.generation===generation;
    const target=await vscode.window.showQuickPick(versions,{title:'升级结构：选择目标版本',placeHolder:`当前 DataVersion：${from}。仅列出更新的正式版。`});
    if(!target||!canWrite())return;
    const copy='创建副本',overwrite='覆盖原文件';
    const mode=await vscode.window.showQuickPick([copy,overwrite],{title:'升级结构：是否创建副本？'});
    if(!mode||!canWrite())return;
    if(mode===overwrite&&(doc.hasEdits||doc.recovered))throw new Error('为保留撤销历史，请先保存并关闭重开，再覆盖升级；也可选择创建副本。');
    const {dir,name}=path.parse(doc.file),destination=mode===copy?path.join(dir,`${name}_${target.label}.nbt`):undefined;
    const confirmed=await vscode.window.showWarningMessage(`将结构升级到 Minecraft ${target.label}？`,{modal:true,
      detail:'升级会转换结构内部格式，升级后无法降级。'+(destination?`原件保留，将创建 ${path.basename(destination)}。`:'原文件将被覆盖，建议先备份。')},'确认升级');
    if(confirmed!=='确认升级'||!canWrite())return;
    const src=this.resource(doc);
    let jar=src?.kind==='jar'&&(await readJarVersion(src.path).catch(()=>null))?.world_version===target.dv?src.path:await this.cachedJar(target.dv);
    if(!canWrite())return;
    if(!jar){
      if(this.downloadingJar)throw new Error('已有官方 JAR 正在下载，请稍后重试。');
      this.downloadingJar=true;
      try{jar=await this.downloadJar(target.label);}finally{this.downloadingJar=false;}
      if(!jar||!canWrite())return;
    }
    if(!await this.writeUpgrade(doc,jar,target,destination,canWrite))return;
    if(destination){
      void vscode.commands.executeCommand('vscode.openWith',vscode.Uri.file(destination),VIEW).then(undefined,e=>vscode.window.showErrorMessage(e.message));
      void vscode.window.showInformationMessage(`已创建并升级副本：${path.basename(destination)}`);
    }else{
      doc.resource={kind:'jar',path:jar};doc.loadNotice=null;
      await Promise.all([...doc.panels].map(pane=>this.loadWebview(pane)));
    }
  }
  recordChange(change){change.document.hasEdits=true;this.changes.fire(change);}
  async editDocument(doc,p,m){
    const {panel}=p;
    if(m.edit?.mask!==undefined||m.edit?.blockFilter?.tag)await this.documentMasks(doc);
    const paste=m.edit?.tool==='paste',clip=paste?this.templates.get(m.edit.template)?.clip:null;
    if(paste&&!clip)throw new Error('临时模板不存在');
    const {changes,tiles,skipped,limited,added,data,selection,token,offset,size,entityOnly,entityChanges}=await doc.call('edit',{...m.edit,palette:p.palette},clip);
    if(token){
      const refresh=async (shift,selected)=>{
        if(entityOnly)return doc.refreshEntities();
        for(const pane of doc.panels)if(pane.active)await doc.view(pane,shift?{offset:shift,selection:pane===p?selected:undefined}:undefined);
      };
      const apply=redo=>doc.run(async()=>{
        await doc.call('restoreLayout',token,redo);
        await refresh(redo?offset:offset?.map(n=>-n),redo?selection:m.edit.selection);
      });
      this.recordChange({document:doc,label:paste?'放置带实体的模板':m.edit.tool==='extrude'?'挤出并扩展结构':'放置并扩展结构',undo:()=>apply(false),redo:()=>apply(true)});
      await refresh(offset,selection);
    }else if(changes.length||entityChanges?.length){
      const send=async (data,states,picked)=>{
        const patch={type:'patch',data,added:states,selection:picked};
        if(!entityChanges?.length&&!tiles?.length){doc.broadcast(patch);return;}
        const rows=entityChanges?.length?await doc.call('entityRows'):undefined,indices=m.edit.entitySelection?.map(e=>e.index)??[];
        const profiles=new Map();
        for(const pane of doc.panels)if(pane.active){
          if(tiles?.length&&!profiles.has(pane.palette))profiles.set(pane.palette,await doc.call('headProfiles',tiles.map(t=>t[0]),pane.palette));
          pane.panel.webview.postMessage({...patch,headProfiles:profiles.get(pane.palette),entityRows:rows,entitySelection:rows&&pane===p?indices:undefined});
        }
      };
      const apply=after=>doc.run(async()=>send(await doc.call('apply',changes,after,tiles,added,entityChanges),undefined,selection?(after?selection:m.edit.selection??[]):undefined));
      this.recordChange({document:doc,label:m.edit.tool==='state'?'修改单个方块状态':m.edit.tool==='tile'?'编辑方块实体':m.edit.tool==='tileInit'?'初始化方块实体':m.edit.tool==='move'?'移动选区':m.edit.tool==='rotate'?'旋转选区':paste?'粘贴临时模板':m.edit.tool==='extrude'?'挤出选区':m.edit.box?'编辑选区':'编辑方块',undo:()=>apply(false),redo:()=>apply(true)});
      await send(data,added);
    }
    if(skipped)panel.webview.postMessage({type:'info',message:`保护了 ${skipped} 个含 NBT 的方块。若要删除目标原有 NBT，请勾选“允许丢弃目标方块实体数据”。`});
    if(limited)panel.webview.postMessage({type:'info',message:`已旋转位置；${limited} 格含无法完整倾转的状态，相关属性已保留。`});
    panel.webview.postMessage({type:'ack',commandText:m.commandText,selection,pasted:paste,...(size?{notice:`结构范围已扩展至 ${size.join(' × ')}${offset.some(Boolean)?'（原有内容已随原点平移）':''}。`}:{})});
  }
  async changeLayout(doc,p,m){
    const {panel}=p;
    const q={...m.layout,palette:p.palette,crop:false};let summon;
    if(q.kind==='entity'&&q.action==='add'){
      const src=this.resource(doc);
      if(src?.kind!=='jar')throw new Error('请先选择原版客户端 JAR');
      const dv=await doc.call('entityBounds',q.pos);
      const {version}=await gameClasspath(src.path);
      if(dv!==null&&version.world_version!==dv)throw new Error(`所选 JAR（${version.id}）与结构 DataVersion ${dv} 不同。请选择匹配的 JAR 后再新增实体。`);
      const result=await summonEntity(src.path,q.id,q.pos,q.snbt);q.summoned=result.nbt;
      summon=result.version;
    }
    if(q.kind==='entity'&&q.action==='delete'){
      const {id,revision}=await doc.call('entityDetails',q.index);
      if(revision!==q.revision)throw new Error('实体已变更，请重新选取');
      const yes=await vscode.window.showWarningMessage(`删除实体 #${q.index+1}（${id}）？`,{modal:true},'删除实体');
      if(yes!=='删除实体'){panel.webview.postMessage({type:'ack'});return;}
    }
    let change=await doc.call('layout',q);
    if(change?.confirm){const {cut,cutTiles,cutEntities}=change.confirm;
      const yes=await vscode.window.showWarningMessage(`缩小结构会裁去 ${cut} 条方块记录（含 ${cutTiles} 个方块实体）和 ${cutEntities} 个实体。`,{modal:true},'裁剪并应用');
      if(yes==='裁剪并应用')change=await doc.call('layout',{...q,crop:true});else change=null;
    }
    if(change?.token){
      const refresh=async active=>{
        if(q.kind==='entity')return doc.refreshEntities();
        if(q.kind==='snbt')doc.maskPack=null;
        for(const pane of doc.panels){if(pane===p)pane.palette=active;if(pane.active){await doc.view(pane);if(q.kind==='snbt')void this.showMasks(doc,pane);}}
      };
      const apply=redo=>doc.run(async()=>refresh(await doc.call('restoreLayout',change.token,redo)));
      this.recordChange({document:doc,label:{entity:'编辑结构实体',snbt:'编辑结构 SNBT',size:'修改结构大小',paletteAdd:'添加调色板',paletteDelete:'删除调色板',paletteClean:'清除未使用颜料',paletteState:'修改变体状态'}[q.kind],undo:()=>apply(false),redo:()=>apply(true)});
      await refresh(change.active);
    }
    panel.webview.postMessage({type:'ack',commandText:m.commandText,entity:change?.entity,snbt:q.kind==='snbt',...(summon?{notice:`已按 ${summon} 新增实体。`}:{}),...(q.kind==='paletteClean'?{notice:change?.removed?`已清除 ${change.removed} 个未使用状态槽位。`:'调色板没有未使用的状态。'}:{})});
  }
  async resolveCustomEditor(doc,panel){
    const media=vscode.Uri.joinPath(this.context.extensionUri,'media');
    const p={doc,panel,palette:0,active:false,alive:true,media};doc.panels.add(p);this.panels.add(p);
    const sub=panel.webview.onDidReceiveMessage(m=>{
      if(!m||typeof m.type!=='string')return;
      if(m.type==='centerCursor'){
        const {dx,dy}=m;
        if(process.platform==='win32'&&!vscode.env.remoteName&&vscode.env.uiKind===vscode.UIKind.Desktop&&
          p.alive&&p.active&&panel.active&&vscode.window.state.focused&&[dx,dy].every(v=>Number.isSafeInteger(v)&&Math.abs(v)<=20000)){
          execFile(path.join(__dirname,'lib','CenterCursor.exe'),[process.execPath,String(dx),String(dy)],{windowsHide:true,timeout:500},()=>{});
        }
        return;
      }
      if(m.type==='saveBrushPreset'||m.type==='deleteBrushPreset'){
        if(p.active)(m.type==='saveBrushPreset'?this.saveBrushPreset(m.state):this.deleteBrushPreset(m.label)).catch(e=>vscode.window.showErrorMessage(e.message));
        return;
      }
      if(m.type==='playerSkin'){
        const generation=p.generation;
        if(p.active&&this.resource(doc)?.kind==='jar'&&Number.isSafeInteger(m.request))void playerSkin(m.profile??{}).then(skin=>{
          if(p.alive&&p.generation===generation)panel.webview.postMessage({type:'playerSkin',request:m.request,skin});
        });
        return;
      }
      if(m.type==='warmSummon'){
        const src=this.resource(doc);
        if(p.active&&src?.kind==='jar')void prepareSummon(src.path).catch(()=>{});
        return;
      }
      if(['resource','shortcut','resetKeys','navigation','rendering','dismissMaterialIntro'].includes(m.type)){this.prefEvent(p,m).catch(e=>vscode.window.showErrorMessage(e.message));return;}
      const generation=p.generation;
      doc.run(async()=>{
        await doc.ready;
        if(!p.alive||p.generation!==generation||(m.type!=='ready'&&!p.active))return;
        switch(m.type){
          case 'ready':
            if(!await this.checkUpgrade(doc)){
              if(p.alive&&p.generation===generation)panel.webview.postMessage({type:'fatal',message:'未加载原结构。'});
              break;
            }
            if(!p.alive||p.generation!==generation)break;
            if(p.jarPath!==this.resource(doc)?.path){await this.loadWebview(p);break;}
            p.active=true;this.showPrefs(p);this.showBrushPresets(p);await doc.view(p);this.showTemplates(p);
            if(doc.matchedJar&&p.assetsLoaded&&doc.loadNotice!==p.jarPath){
              doc.loadNotice=p.jarPath;void vscode.window.showInformationMessage(`已使用 Minecraft ${doc.matchedJar} JAR 加载 ${path.basename(doc.file)}`);
            }
            try{await this.repairOfficialJar(doc.matchedJar,p.jarPath);}
            catch(e){void vscode.window.showWarningMessage(`官方依赖未能补齐：${e.message}。可在「使用官方源」重新选择同一版本重试。`);}
            if(p.alive&&p.generation===generation){void this.showMasks(doc,p);void this.showEntityModels(p);void this.showCollisionShapes(doc,p);}
            break;
          case 'upgradeStructure':await this.upgradeStructure(doc,p);if(p.alive&&p.generation===generation)panel.webview.postMessage({type:'ack'});break;
          case 'palette':p.palette=Number(m.palette);await doc.view(p);break;
          case 'snbt':panel.webview.postMessage({type:'snbt',...await doc.call('snbt')});break;
          case 'entityDetails':panel.webview.postMessage({type:'entityDetails',data:await doc.call('entityDetails',m.index)});break;
          case 'copyEntity':this.storeTemplate(p,await doc.call('copyEntity',m.index));break;
          case 'copyTemplate':this.storeTemplate(p,await doc.call('copySelection',m.selection,p.palette,true,m.region,m.entitySelection??[]));break;
          case 'saveTemplate':{
            const entry=this.templates.get(m.id);if(!entry)throw new Error('临时模板不存在');
            const uri=await vscode.window.showSaveDialog({defaultUri:vscode.Uri.file(path.join(path.dirname(doc.file),`template_${m.id}.nbt`)),filters:{'结构 NBT':['nbt']},saveLabel:'保存模板'});
            if(!uri)break;
            let file=uriCheck(uri);const appendExt=!file.toLowerCase().endsWith('.nbt');if(appendExt)file+='.nbt';
            if(path.resolve(file).toLowerCase()===path.resolve(doc.file).toLowerCase())throw new Error('请换一个文件名，以免覆盖当前打开的结构。');
            const bytes=await promisify(gzip)(clipBytes(entry.clip));
            if(appendExt)await fs.writeFile(file,bytes,{flag:'wx'});else await atomicFile(file,bytes);
            panel.webview.postMessage({type:'notice',message:`已保存模板：${path.basename(file)}`});break;
          }
          case 'dropTemplate':if(this.templates.delete(m.id))for(const pane of this.panels)if(pane.active)this.showTemplates(pane);break;
          case 'previewTemplate':{
            const entry=this.templates.get(m.id);if(!entry)throw new Error('临时模板不存在');
            panel.webview.postMessage({type:'previewTemplate',id:m.id,states:entry.clip.states,blocks:entry.clip.blocks.map(b=>[...b.pos,b.id]),entities:clipEntityPreview(entry.clip),headProfiles:clipHeadProfiles(entry.clip)});break;
          }
          case 'edit':await this.editDocument(doc,p,m);break;
          case 'layout':await this.changeLayout(doc,p,m);break;
          case 'tileValue':panel.webview.postMessage({type:'tileValue',data:await doc.call('tileValue',m.cell,m.path),cell:m.cell,path:m.path});break;
          case 'inspect':panel.webview.postMessage({type:'inspect',data:await doc.call('inspect',m.cell),cell:m.cell});break;

          case 'save':void vscode.commands.executeCommand('workbench.action.files.save');break;
          case 'undo':void vscode.commands.executeCommand('undo');break;
          case 'redo':void vscode.commands.executeCommand('redo');break;
        }
      }).catch(e=>panel.webview.postMessage({type:m.type==='ready'?'fatal':'error',message:e.message,request:m.type==='layout'&&m.layout?.kind==='snbt'?'snbtApply':m.type}));
    });
    panel.onDidDispose(()=>{p.alive=false;sub.dispose();doc.panels.delete(p);this.panels.delete(p);});
    try{
      p.template=await fs.readFile(vscode.Uri.joinPath(media,'index.html').fsPath,'utf8');
      await this.loadWebview(p,true);
    }catch(e){panel.webview.html='<p>Voxel NBT Studio 的本地界面资源缺失。请重新安装插件。</p>';}
  }
  saveCustomDocument(doc,token){return doc.run(async()=>{await doc.ready;cancel(token);const {data,hash:h}=await doc.call('save');cancel(token);await atomicFile(doc.file,data,doc.disk);doc.disk=h;});}
  saveCustomDocumentAs(doc,target,token){return doc.run(async()=>{await doc.ready;cancel(token);const {data}=await doc.call('save');cancel(token);await atomicFile(uriCheck(target),data);});}
  revertCustomDocument(doc,token){return doc.run(async()=>{await doc.ready;cancel(token);doc.disk=await doc.call('load',doc.file,null);doc.maskPack=null;for(const p of doc.panels)if(p.active){p.panel.webview.postMessage({type:'maskCatalog'});p.palette=0;await doc.view(p);void this.showMasks(doc,p);}});}
  backupCustomDocument(doc,context,token){return doc.run(async()=>{await doc.ready;cancel(token);const file=uriCheck(context.destination);await fs.mkdir(path.dirname(file),{recursive:true});const {data}=await doc.call('save');cancel(token);await atomicFile(file,data);return {id:context.destination.toString(),delete:()=>fs.unlink(file).catch(()=>{})};});}
}
function activate(context){
  const hint=()=>addHint((vscode.workspace.workspaceFolders??[]).map(f=>f.uri.fsPath));
  hint();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(hint));
  const provider=new Provider(context);
  const source=provider.prefs().resource;if(source?.kind==='jar'&&typeof source.path==='string')addHint(path.dirname(source.path));
  for(const action of ['view','place','paint','erase','pick','extrude','box','clearSelection','resize','paletteAdd','paletteDelete','axisXMinus','axisXPlus','axisYMinus','axisYPlus','axisZMinus','axisZPlus','topView','reset','flyView','material','invisibleBlocks','paletteState','tileSave','tileDelete','toggleMoveTile','settings'])context.subscriptions.push(vscode.commands.registerCommand('voxelNbt.'+action,()=>provider.command(action)));
  const open=async uri=>{if(!uri){const chosen=await vscode.window.showOpenDialog({canSelectMany:false,filters:{'Java 结构 NBT':['nbt']}});uri=chosen?.[0];}if(uri)await vscode.commands.executeCommand('vscode.openWith',uri,VIEW);};
  context.subscriptions.push(provider.changes,vscode.window.registerCustomEditorProvider(VIEW,provider,{webviewOptions:{retainContextWhenHidden:true},supportsMultipleEditorsPerDocument:true}),vscode.commands.registerCommand('voxelNbt.open',open),vscode.commands.registerCommand('voxelNbt.create',async()=>{
    const text=await vscode.window.showInputBox({title:'新建结构：宽 X、高 Y、深 Z',value:'32,32,32',validateInput:v=>{if(!/^\s*\d+\s*[,， ]\s*\d+\s*[,， ]\s*\d+\s*$/.test(v))return '例如 32,32,32';try{create(v.match(/\d+/g).map(Number));}catch(e){return e.message;}}});if(!text)return;
    const uri=await vscode.window.showSaveDialog({filters:{'Java 结构 NBT':['nbt']}});if(!uri)return;
    try{const src=provider.prefs().resource,dv=src?.kind==='jar'?(await jarMaskData(src.path)).dataVersion??undefined:undefined;
      const file=uriCheck(uri), to=file.toLowerCase().endsWith('.nbt')?file:file+'.nbt';await fs.writeFile(to,await promisify(gzip)(create(text.match(/\d+/g).map(Number),dv)),{flag:'wx'});await open(vscode.Uri.file(to));}catch(e){vscode.window.showErrorMessage(e.code==='EEXIST'?'文件已存在，请换一个名称。':e.message);}
  }));
}
module.exports={activate,deactivate:stopSummon};
