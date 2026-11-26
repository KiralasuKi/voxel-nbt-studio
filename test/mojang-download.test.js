'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {clientVersions,downloadClient,officialDownload}=require('../lib/mojang');
const {installOfficialClient,officialJarPath,dependenciesInstalled}=require('../lib/mojang-install');
const digest=data=>createHash('sha1').update(data).digest('hex');

test('official client download filters releases, verifies content, reuses valid cache and aborts',async t=>{
 const app=Buffer.from('valid JAR payload'),clientUrl='https://piston-data.mojang.com/client.jar';
 const dep=Buffer.from('netty'),mapping=Buffer.from('mappings');
 const nettyPath='io/netty/netty-common/4.1.115.Final/netty-common-4.1.115.Final.jar';
 const artifact=(data,url,extra)=>({sha1:digest(data),size:data.length,url,...extra});
 const lib=artifact(dep,'https://libraries.minecraft.net/'+nettyPath,{path:nettyPath});
 const libraries=[lib,{...lib,path:'../escape.jar'},{...lib,path:'minecraft/lwjgl-natives-windows.jar'}].map(artifact=>({downloads:{artifact}}));
 const meta=Buffer.from(JSON.stringify({id:'26.3',downloads:{client:artifact(app,clientUrl),client_mappings:artifact(mapping,'https://piston-data.mojang.com/mappings.txt')},libraries}));
 const release=(id,type='release')=>({id,type,url:'https://piston-meta.mojang.com/release.json',sha1:digest(meta)});
 const manifest=JSON.stringify({versions:[release('1.21'),release('26.3'),release('1.21.2'),release('26.3.1'),release('26.3-pre1','snapshot'),release('26.2.1','snapshot'),release('1.20.6'),release('1.21.10'),release('26.3')]});
 let downloads=0,libraryDownloads=0,payload=app,libraryPayload=dep;
 const request=t.mock.method(global,'fetch',async(url,options)=>{
  assert.equal(options.redirect,'error');options.signal.throwIfAborted();
  if(url.pathname.endsWith('version_manifest_v2.json'))return new Response(manifest);
  if(url.pathname==='/release.json')return new Response(meta);
  if(url.href===lib.url){libraryDownloads++;return new Response(libraryPayload);}
  if(url.pathname==='/mappings.txt')return new Response(mapping);
  assert.equal(url.href,clientUrl);downloads++;return new Response(payload);
 });
 const root=path.resolve(await fs.mkdtemp(path.join(os.tmpdir(),'voxel_download_test_'))),file=path.join(root,'26.3.jar');
 try{
  assert.deepEqual(await clientVersions(),['26.3','1.21.10','1.21.2','1.21']);
  assert.deepEqual(await downloadClient('26.3',file),app);
  await fs.writeFile(file,app);
  assert.equal(await downloadClient('26.3',file),null);assert.equal(downloads,1);
  await fs.writeFile(file,Buffer.alloc(app.length));
  payload=Buffer.alloc(app.length);
  await assert.rejects(downloadClient('26.3',file),/校验失败/);
  assert.deepEqual(await fs.readFile(file),payload);
  payload=Buffer.alloc(app.length+1);
  await assert.rejects(downloadClient('26.3',file),/大小限制/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(downloadClient('26.3',file,controller.signal),{name:'AbortError'});
  await assert.rejects(downloadClient('../26.3',file),/仅支持/);
  await assert.rejects(downloadClient('26.2.1',file),/版本清单没有/);
  const before=request.mock.callCount();
  await assert.rejects(officialDownload('https://piston-data.mojang.com.evil.invalid/client.jar',20,digest(app)),/资源来源/);
  assert.equal(request.mock.callCount(),before);
  const game=officialJarPath(root,'26.3'),netty=path.join(root,'libraries',nettyPath);
  await fs.mkdir(path.dirname(game),{recursive:true});await fs.writeFile(game,app);
  assert.equal(await dependenciesInstalled(game),false);
  libraryPayload=Buffer.alloc(dep.length);
  await assert.rejects(installOfficialClient(root,'26.3'),/校验失败/);
  assert.equal(await dependenciesInstalled(game),false);
  libraryPayload=dep;
  const clients=downloads;
  assert.equal(await installOfficialClient(root,'26.3'),game);
  assert.equal(await dependenciesInstalled(game),true);
  assert.deepEqual(await fs.readFile(netty),dep);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(game),'client-mappings.txt')),mapping);
  assert.equal(await installOfficialClient(root,'26.3'),game);
  assert.equal(libraryDownloads,2);assert.equal(downloads,clients);
 }finally{
  if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('voxel_download_test_'))await fs.rm(root,{recursive:true,force:true});
 }
});

// Desktop VS Code can expose its on-disk profile storage with the vscode-userdata scheme.
test('official download saves and selects the JAR in VS Code profile storage',async()=>{
 const Module=require('node:module');
 const root=path.resolve(await fs.mkdtemp(path.join(os.tmpdir(),'voxel_download_test_')));
 const file=path.join(root,'versions','26.3','26.3.jar'),payload=Buffer.from('JAR');
 let provider,prefs={resource:{kind:'none'}};
 const token={isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})};
 const vscode={EventEmitter:class{},ProgressLocation:{Notification:1},workspace:{onDidChangeWorkspaceFolders(){}},commands:{registerCommand(){}},
  window:{registerCustomEditorProvider(_view,p){provider=p;},showQuickPick:async items=>items[0],withProgress:async(_options,task)=>task({report(){}},token)}};
 const loader=Module._load,entry=require.resolve('../extension');
 try{
  Module._load=function(name,...args){
   if(name==='vscode')return vscode;
   if(name==='./lib/mojang')return {...loader.call(this,name,...args),clientVersions:async()=>['26.3']};
   if(name==='./lib/mojang-install')return {...loader.call(this,name,...args),installOfficialClient:async(storage,version)=>{
    assert.equal(storage,root);assert.equal(version,'26.3');
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,payload);return file;
   }};
   if(name==='./lib/assets')return {...loader.call(this,name,...args),jarFolder:async(target,dir)=>{
    assert.equal(dir,root);assert.equal(target,file);assert.deepEqual(await fs.readFile(file),payload);
   }};
   return loader.call(this,name,...args);
  };
  try{require('../extension').activate({subscriptions:[],globalStorageUri:{scheme:'vscode-userdata',fsPath:root},
    globalState:{get:()=>prefs,update:async(_key,value)=>{prefs=value;}}});}
  finally{Module._load=loader;delete require.cache[entry];}
  await provider.prefEvent(null,{type:'resource',kind:'download'});
  assert.deepEqual(prefs.resource,{kind:'jar',path:file});
  assert.throws(()=>provider.openCustomDocument({scheme:'git'},{}),/请使用本地文件/);
 }finally{
  if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('voxel_download_test_'))await fs.rm(root,{recursive:true,force:true});
 }
});
