'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Module=require('node:module'),path=require('node:path');

function provider(f,from=3955,to=5023){
  const calls=[],uri=file=>({scheme:'file',fsPath:file,toString:()=>file});
  const file=f.file,resource={kind:'jar',path:'client.jar'};
  let prefs={resource:f.noJar?null:f.colorOnly?{kind:'none'}:resource};
  class TabInputCustom{
    constructor(file){this.viewType='voxelNbt.structure';this.uri=uri(file);}
  }
  const tab={input:new TabInputCustom(file)};
  const vscode={TabInputCustom,Uri:{file:uri,joinPath:(base,...parts)=>uri(path.join(base.fsPath,...parts))},ProgressLocation:{Notification:1},EventEmitter:class{},
    workspace:{onDidChangeWorkspaceFolders(){}},
    commands:{registerCommand(){},async executeCommand(command,target){calls.push([command,target.fsPath]);}},
    window:{registerCustomEditorProvider(_view,p){f.provider=p;},
      tabGroups:{all:[{tabs:[tab,{input:new TabInputCustom('different.nbt')}]}],async close(tabs){assert.deepEqual(tabs,[tab]);calls.push('close');}},
      async showInformationMessage(message){calls.push(message);},
      async showQuickPick(items){const target=f.picks?.shift();return items.find(item=>typeof item==='string'?item===target:item.label===target);},
      async showWarningMessage(title,opts,...items){
        assert.equal(opts.modal,true);
        if(title.startsWith('将结构升级')){calls.push('confirm');f.confirmDetail=opts.detail;return f.confirm;}
        calls.push('prompt');assert.match(title,/sample\.nbt/);
        f.prompt={detail:opts.detail,options:items.map(i=>i.title)};
        const choice=f.choices?f.choices.shift():f.choice;
        return items.find(item=>item.title===choice);
      },
      async withProgress(_options,task){return task();}},
  };
  const loader=Module._load,filename=require.resolve('../extension');
  delete require.cache[filename];
  Module._load=function(name,...args){
    if(name==='vscode')return vscode;
    if(name==='./lib/assets')return {...loader.call(this,name,...args),readJarVersion:async jar=>jar===resource.path
      ?{id:'26.3',world_version:to}:{id:'1.21.1',world_version:f.downloadedDataVersion??3955}};
    return loader.call(this,name,...args);
  };
  try{require('../extension').activate({subscriptions:[],extensionUri:uri(path.resolve(__dirname,'..')),globalState:{get:()=>prefs,update:async(_key,value)=>{prefs=value;}}});}
  finally{Module._load=loader;delete require.cache[filename];}
  const doc={file,uri:uri(file),panels:new Set([{}]),hasEdits:f.hasEdits,recovered:f.recovered,
    async call(method){assert.equal(method,'dataVersion');return from;},
    queue:Promise.resolve(),run(fn){this.queue=this.queue.then(fn);return this.queue;},
    view(p){p.panel.webview.postMessage({type:'model'});},
    async upgrade(jar,dv,dest,canWrite){assert.equal(jar,f.upgradeJar??resource.path);assert.equal(dv,f.upgradeDV??to);assert.equal(canWrite(),true);calls.push(dest??'update');if(f.error)throw f.error;return true;}};
  f.provider.downloadJar=async version=>{calls.push(['download',version]);return f.downloadedFile;};
  f.provider.cachedJar=async dv=>f.cache?.[dv];
  return {doc,calls,check:()=>f.provider.checkUpgrade(doc),resource:()=>f.provider.resource(doc),defaultResource:()=>prefs.resource};
}

test('older NBT prompts before preview; the copy opens separately, original update continues, and cancellation closes',async()=>{
  for(const [choice,preview] of [['创建副本后更新',false],['更新',true],['不加载',false],[undefined,false]]){
    const f={file:require('node:path').resolve('sample.nbt'),choice};
    const {calls,check}=provider(f),copy=require('node:path').resolve('sample_26.3.nbt');
    assert.equal(await check(),preview);
    await Promise.resolve();
    assert.deepEqual(calls,choice==='创建副本后更新'?['prompt',copy,'close',['vscode.openWith',copy]]:choice==='更新'?['prompt','update']:['prompt','close']);
    if(!preview){assert.equal(await check(),false);assert.equal(calls.filter(c=>c==='prompt').length,1);}
  }
});

test('the mismatch prompt cannot overwrite edits, recovery, or newer structures',async()=>{
  const file='sample.nbt';
  for(const [input,from] of [[{hasEdits:true},3955],[{recovered:true},3955],[{},6000]]){
    const f={file,choice:'用色块加载',...input};
    const {calls,check,resource}=provider(f,from);
    assert.equal(await check(),true);assert.equal(resource().kind,'none');
    assert.deepEqual(calls,['prompt']);assert.ok(!f.prompt.options.includes('更新'));
  }
  for(const [from,noJar] of [[null,false],[5023,false],[3955,true]]){
    const {calls,check}=provider({file,noJar},from);
    assert.equal(await check(),true);assert.deepEqual(calls,[]);
  }
  const {calls,check}=provider({file,choice:'创建副本后更新',error:Object.assign(new Error('exists'),{code:'EEXIST'})});
  await assert.rejects(check(),/sample_26\.3\.nbt.*已存在/);
  assert.equal(calls.includes('close'),false);
});

const auto='自动选用 1.21.1（官方源）';
test('auto-select uses the exact official JAR and keeps the original structure open without upgrading',async()=>{
  const f={file:'sample.nbt',choice:auto,downloadedFile:'official-1.21.1.jar'};
  const {calls,doc,check,resource,defaultResource}=provider(f);
  assert.equal(await check(),true);
  assert.equal(defaultResource().path,'client.jar');
  assert.equal(doc.openBlocked,undefined);
  assert.deepEqual(resource(),{kind:'jar',path:f.downloadedFile});
  assert.equal(await check(),true);
  assert.deepEqual(calls,['prompt',['download','1.21.1']]);
});

test('the dialog recovers from canceled or nonmatching downloads and skips unknown versions',async()=>{
  for(const result of [{},{downloadedFile:'wrong.jar',downloadedDataVersion:5023}]){
    const f={file:'sample.nbt',choices:[auto,'不加载'],...result};
    const {calls,check,resource}=provider(f);
    assert.equal(await check(),false);
    assert.equal(resource().path,'client.jar');
    assert.match(f.prompt.detail,result.downloadedFile?/DataVersion 与结构不符/:/已取消下载/);
    assert.deepEqual(calls,['prompt',['download','1.21.1'],'prompt','close']);
  }
  const f={file:'sample.nbt',choice:'不加载'};
  const {check}=provider(f,3954);
  await check();assert.deepEqual(f.prompt.options,['创建副本后更新','更新','用色块加载','不加载']);
});


test('cached official JAR is switched before preview without prompting or changing other files',async()=>{
  const f={file:'sample.nbt',cache:{3955:'official-1.21.1.jar'}};
  const {calls,doc,defaultResource}=provider(f);
  doc.panels.clear();
  let receive;const messages=[];
  const panel={webview:{asWebviewUri:uri=>uri,onDidReceiveMessage(fn){receive=fn;return {dispose(){}};},postMessage:m=>messages.push(m.type)},onDidDispose(){}};
  f.provider.assets=async src=>src?.path;
  f.provider.showMasks=f.provider.showEntityModels=f.provider.showCollisionShapes=()=>{};
  await f.provider.resolveCustomEditor(doc,panel);
  receive({type:'ready'});await doc.queue;
  assert.deepEqual(messages,[]);assert.equal(defaultResource().path,'client.jar');
  receive({type:'ready'});await doc.queue;
  assert.ok(messages.includes('model'));
  assert.deepEqual(calls,['已使用 Minecraft 1.21.1 JAR 加载 sample.nbt']);
  const other={...doc,resource:undefined,call:async()=>5023};
  assert.equal(await f.provider.checkUpgrade(other),true);
  assert.equal(f.provider.resource(other).path,'client.jar');
});

test('toolbar upgrades only a newer version after confirmation, with an optional separate copy',async()=>{
  const file='sample.nbt',pane={alive:true,generation:1},cache={4903:'cached-26.2.jar'};
  const base={file,cache,upgradeJar:cache[4903],upgradeDV:4903};
  for(const confirm of [undefined,'确认升级']){
    const f={...base,picks:['26.2','创建副本'],confirm,hasEdits:true};
    const {calls,doc}=provider(f);
    await f.provider.upgradeStructure(doc,pane);
    assert.match(f.confirmDetail,/无法降级/);assert.match(f.confirmDetail,/sample_26.2.nbt/);
    assert.deepEqual(calls,confirm?['confirm','sample_26.2.nbt',['vscode.openWith','sample_26.2.nbt'],'已创建并升级副本：sample_26.2.nbt']:['confirm']);
    assert.equal(doc.resource,undefined);
  }
  const f={...base,picks:['26.2','覆盖原文件'],confirm:'确认升级'};
  const {calls,doc,resource}=provider(f);
  f.provider.loadWebview=async()=>{calls.push('reload');};
  await f.provider.upgradeStructure(doc,pane);
  assert.deepEqual(calls,['confirm','update','reload']);assert.equal(resource().path,cache[4903]);
  for(const edited of [true,false]){
    const rejected={...base,hasEdits:edited,picks:['26.2','覆盖原文件'],confirm:'确认升级'};
    const {doc,calls}=provider(rejected,edited?3955:5023);
    await assert.rejects(rejected.provider.upgradeStructure(doc,pane),edited?/保存并关闭重开/:/没有.*更新/);
    assert.deepEqual(calls,[]);
  }
});
