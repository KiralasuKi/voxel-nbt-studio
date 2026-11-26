'use strict';
const vscode=require('vscode');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {Document,atomicFile}=require('./lib/document');
const {gzip}=require('node:zlib');
const {promisify}=require('node:util');
const {create,validateState,clipThumb,clipBytes,clipEntityPreview,clipHeadProfiles}=require('./lib/nbt');
const {jarFolder,jarMaskData}=require('./lib/assets');
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
  constructor(context){this.context=context;this.panels=new Set();this.templates=new Map();this.templateCounter=0;this.changes=new vscode.EventEmitter();this.onDidChangeCustomDocument=this.changes.event;}
  prefs(){const prefs=this.context.globalState.get('voxel.prefs',{});return prefs.resource?.kind==='folder'?{...prefs,resource:undefined}:prefs;}
  showPrefs(p){p.panel.webview.postMessage({type:'prefs',prefs:this.prefs()});}
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
  async maskSource(){
    const src=this.prefs().resource;if(src?.kind!=='jar')return null;
    const st=await fs.stat(src.path),key=src.path+'|'+st.size+'|'+st.mtimeMs;
    if(this.maskCache?.key!==key){
      const data=Promise.all([jarMaskData(src.path),collisionShapes(src.path).catch(()=>null)]).then(([raw,game])=>({...raw,traits:game?.traits??null}));
      this.maskCache={key,data};data.catch(()=>{if(this.maskCache?.key===key)this.maskCache=null;});
    }
    return {key,jar:src.path,catalog:await this.maskCache.data};
  }
  async documentMasks(doc){
    const pack=await this.maskSource();if(!pack)throw new Error('方块掩码需要在设置里选择原版客户端 JAR');
    if(doc.maskPack?.key!==pack.key){
      const data=doc.call('maskCatalog',pack.catalog,pack.jar,librariesRoots(pack.jar)).then(legacy=>legacy?{...pack.catalog,legacy}:pack.catalog);
      doc.maskPack={key:pack.key,data};data.catch(()=>{if(doc.maskPack?.data===data)doc.maskPack=null;});
    }
    return doc.maskPack.data;
  }
  async showMasks(doc,p){
    const source=this.prefs().resource,generation=p.generation;
    if(source?.kind!=='jar')return;
    try{const catalog=await this.documentMasks(doc);if(p.alive&&p.generation===generation&&this.prefs().resource?.path===source.path)p.panel.webview.postMessage({type:'maskCatalog',catalog});}
    catch(e){if(p.alive&&p.generation===generation)p.panel.webview.postMessage({type:'maskCatalog',error:e.message});}
  }
  async assets(){
    const src=this.prefs().resource;
    if(src?.kind!=='jar')return null;
    const cache=await jarFolder(src.path,this.context.globalStorageUri.fsPath);
    return vscode.Uri.file(cache);
  }
  async loadWebview(p){
    const web=p.panel.webview;let assets;
    try{assets=await this.assets();}catch(e){if(this.prefs().resource?.path)vscode.window.showWarningMessage('Voxel NBT Studio: '+e.message);}
    if(!p.alive)return;
    web.options={enableScripts:true,localResourceRoots:[p.media,...(assets?[assets]:[])]};
    const res=name=>web.asWebviewUri(vscode.Uri.joinPath(p.media,name)).toString();
    p.active=false;p.generation=(p.generation??0)+1;
    web.html=p.template.replaceAll('__CSP__',web.cspSource).replaceAll('__CSS__',res('style.css')).replaceAll('__APP__',res('editor.js')).replaceAll('__WORKER__',res('mesh.js')).replaceAll('__ASSETS__',assets?web.asWebviewUri(assets).toString().replaceAll('&','&amp;').replaceAll('"','&quot;'):'');
  }
  async prefEvent(p,m){
    if(m.type==='dismissMaterialIntro'){
      if(!this.prefs().materialIntroSeen)await this.context.globalState.update('voxel.prefs',{...this.prefs(),materialIntroSeen:true});
      for(const pane of this.panels)if(pane.active)this.showPrefs(pane);return;
    }
    if(m.type==='rendering'){
      const prefs=this.prefs(),{mode,gamma}=m;
      if(!['smooth','game'].includes(mode)||!Number.isFinite(gamma)||gamma<0||gamma>1)throw new Error('渲染模式或 Gamma 值无效');
      if(mode==='game'&&prefs.resource?.kind!=='jar')throw new Error('游戏风格仅在选择原版客户端 JAR 时可用');
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
    if(!['jar','none'].includes(m.kind))return;
    const src={kind:m.kind};
    if(m.kind==='jar'){
      const [uri]=await vscode.window.showOpenDialog({canSelectMany:false,canSelectFolders:false,canSelectFiles:true,openLabel:'选择 Minecraft 客户端 JAR',filters:{'Minecraft 客户端':['jar']}})||[];
      if(!uri)return;src.path=uriCheck(uri);
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Voxel NBT Studio：验证资源…'},()=>jarFolder(src.path,this.context.globalStorageUri.fsPath));
    }
    void stopSummon();
    await this.context.globalState.update('voxel.prefs',{...this.prefs(),resource:src});
    await Promise.all([...this.panels].map(pane=>this.loadWebview(pane)));
  }
  showTemplates(p){p.panel.webview.postMessage({type:'templates',items:[...this.templates.values()].reverse().map(({meta})=>meta)});}
  async showCollisionShapes(doc,p){
    const src=this.prefs().resource,generation=p.generation;
    if(src?.kind!=='jar'){await doc.call('gameCatalog',null).catch(()=>{});return;}
    const send=m=>{if(p.alive&&p.generation===generation&&this.prefs().resource?.path===src.path)p.panel.webview.postMessage({type:'collisionShapes',...m});};
    try{
      const {blocks,shapes,schema,tiles,turns,dataVersion,version}=await collisionShapes(src.path);
      if(this.prefs().resource?.path!==src.path||!p.alive||p.generation!==generation)return;
      await doc.call('gameCatalog',{schema,tiles,turns,dataVersion});
      send({catalog:{blocks,shapes,schema,tiles,dataVersion,version}});
    }catch(e){if(p.alive&&p.generation===generation&&this.prefs().resource?.path===src.path)await doc.call('gameCatalog',null).catch(()=>{});send({error:e.message});}
  }
  async showEntityModels(p){
    const src=this.prefs().resource,generation=p.generation;
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
      this.changes.fire({document:doc,label:paste?'放置带实体的模板':m.edit.tool==='extrude'?'挤出并扩展结构':'放置并扩展结构',undo:()=>apply(false),redo:()=>apply(true)});
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
      this.changes.fire({document:doc,label:m.edit.tool==='state'?'修改单个方块状态':m.edit.tool==='tile'?'编辑方块实体':m.edit.tool==='tileInit'?'初始化方块实体':m.edit.tool==='move'?'移动选区':m.edit.tool==='rotate'?'旋转选区':paste?'粘贴临时模板':m.edit.tool==='extrude'?'挤出选区':m.edit.box?'编辑选区':'编辑方块',undo:()=>apply(false),redo:()=>apply(true)});
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
      const src=this.prefs().resource;
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
      this.changes.fire({document:doc,label:{entity:'编辑结构实体',snbt:'编辑结构 SNBT',size:'修改结构大小',paletteAdd:'添加调色板',paletteDelete:'删除调色板',paletteClean:'清除未使用颜料',paletteState:'修改变体状态'}[q.kind],undo:()=>apply(false),redo:()=>apply(true)});
      await refresh(change.active);
    }
    panel.webview.postMessage({type:'ack',commandText:m.commandText,entity:change?.entity,snbt:q.kind==='snbt',...(summon?{notice:`已按 ${summon} 新增实体。`}:{}),...(q.kind==='paletteClean'?{notice:change?.removed?`已清除 ${change.removed} 个未使用状态槽位。`:'调色板没有未使用的状态。'}:{})});
  }
  async resolveCustomEditor(doc,panel){
    const media=vscode.Uri.joinPath(this.context.extensionUri,'media');
    const p={panel,palette:0,active:false,alive:true,media};doc.panels.add(p);this.panels.add(p);
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
        if(p.active&&this.prefs().resource?.kind==='jar'&&Number.isSafeInteger(m.request))void playerSkin(m.profile??{}).then(skin=>{
          if(p.alive&&p.generation===generation)panel.webview.postMessage({type:'playerSkin',request:m.request,skin});
        });
        return;
      }
      if(m.type==='warmSummon'){
        const src=this.prefs().resource;
        if(p.active&&src?.kind==='jar')void prepareSummon(src.path).catch(()=>{});
        return;
      }
      if(['resource','shortcut','resetKeys','navigation','rendering','dismissMaterialIntro'].includes(m.type)){this.prefEvent(p,m).catch(e=>vscode.window.showErrorMessage(e.message));return;}
      doc.run(async()=>{
        await doc.ready;
        switch(m.type){
          case 'ready':p.active=true;this.showPrefs(p);this.showBrushPresets(p);await doc.view(p);this.showTemplates(p);void this.showMasks(doc,p);void this.showEntityModels(p);void this.showCollisionShapes(doc,p);break;
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
      await this.loadWebview(p);
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
