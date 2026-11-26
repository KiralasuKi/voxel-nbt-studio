'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto'),{execFile,spawn}=require('node:child_process'),{promisify}=require('node:util');
const {createInterface}=require('node:readline');
const {existsSync}=require('node:fs');
const {javaExe}=require('./java-runtime');
const {jarVersion}=require('./assets'),pins=require('./mask-java.json'),run=promisify(execFile);
const hash=(buf,algo='sha1')=>createHash(algo).update(buf).digest('hex');
const libraryPath=/^(?:[A-Za-z0-9_.+-]+\/)+[A-Za-z0-9_.+-]+\.jar$/;
const official=new Set(['piston-meta.mojang.com','piston-data.mojang.com','launchermeta.mojang.com','launcher.mojang.com']);
async function officialDownload(url,max,digest){
 const u=new URL(url);if(u.protocol!=='https:'||!official.has(u.host)||u.username||u.password)throw new Error('无法验证原版资源来源');
 const r=await fetch(u,{signal:AbortSignal.timeout(45000),redirect:'error'});if(!r.ok)throw new Error('Mojang 下载失败：'+r.status);
 let count=0;const chunks=[];for await(const chunk of r.body){count+=chunk.length;if(count>max)throw new Error('Mojang 版本数据超出限制');chunks.push(chunk);}
 const b=Buffer.concat(chunks);if(digest&&hash(b)!==digest)throw new Error('Mojang 版本数据校验失败');return b;
}
let manifest;
function versions(){
 if(!manifest)manifest=officialDownload('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',4*1024*1024).then(b=>JSON.parse(b).versions).catch(e=>{manifest=null;throw e;});
 return manifest;
}
let cached;
const {librariesRoot,addHint}=require('./paths');
async function gameClasspath(jar){
 const file=await fs.realpath(jar),stat=await fs.stat(file);
 if(!stat.isFile()||stat.size>256*1024*1024||file.includes(path.delimiter)||file.includes('*'))throw new Error('客户端 JAR 无效');
 const key=[file,stat.size,stat.mtimeMs,stat.ctimeMs].join('|');if(cached?.key===key)return cached.value;
 const value=(async()=>{
  const buf=await fs.readFile(file),version=jarVersion(buf);
  if(typeof version.id!=='string'||!Number.isInteger(version.world_version))throw new Error('无法识别所选 JAR 的游戏版本');
  const root=librariesRoot(file);
  const entries=[file];let mappings=null;
  let java=version.java_version??21;
  if(hash(buf,'sha256')===pins.client){
   for(const [name,expected] of Object.entries({...pins.libraries,...pins.summonLibraries})){
    const p=path.join(root,name),b=await fs.readFile(p).catch(()=>{throw new Error('找不到原版依赖：'+name);});
    if(hash(b,'sha256')!==expected)throw new Error('原版依赖校验失败：'+name);entries.push(p);
   }
  }else{
   try{
    const release=(await versions()).find(v=>v.id===version.id);
    if(!release?.sha1)throw new Error('官方版本清单没有 '+version.id);
    const meta=JSON.parse(await officialDownload(release.url,4*1024*1024,release.sha1));
    if(!meta.downloads?.client?.sha1||meta.downloads.client.sha1!==hash(buf))throw new Error('所选客户端 JAR 与官方版本 '+version.id+' 不符');
    java=meta.javaVersion?.majorVersion??java;
    for(const {downloads} of meta.libraries){
     const a=downloads?.artifact;
     if(!a?.sha1||!libraryPath.test(a.path)||a.path.split('/').some(x=>x==='.'||x==='..')||a.path.includes('-natives-')||!Number.isSafeInteger(a.size)||a.size>256*1024*1024)continue;
     const p=path.join(root,a.path),st=await fs.stat(p).catch(e=>{if(e.code!=='ENOENT')throw e;});
     if(!st?.isFile())continue;
     if(st.size!==a.size||hash(await fs.readFile(p))!==a.sha1)throw new Error('原版依赖校验失败：'+a.path);
     entries.push(p);
    }
    const map=meta.downloads.client_mappings;if(map?.sha1)mappings=await officialDownload(map.url,64*1024*1024,map.sha1);
   }catch(e){throw new Error('无法验证所选 JAR（'+version.id+'）：'+(e.cause?.code??e.message));}
  }
  if(entries.some(p=>p.includes(path.delimiter)||p.includes('*')))throw new Error('客户端类路径无效');
  return {cp:[...new Set(entries)].join(path.delimiter),mappings,java,version,libsRoot:root};
 })();
 cached={key,value};value.catch(()=>{if(cached?.value===value)cached=null;});return value;
}
function javaEnv(){
 const env={...process.env};for(const k of Object.keys(env))if(/^(JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i.test(k))delete env[k];return env;
}
let summonSession;
function stopSummon(){
 const old=summonSession;summonSession=null;
 if(!old)return;
 old.cancelled=true;return old.stop?.()??old.value.then(()=>{},()=>{});
}
async function startSummon(slot,game){
 const {cp,mappings,java,version}=game,root=await fs.mkdtemp(path.join(os.tmpdir(),'voxel_summon_java_'));
 const cleanup=()=>{
  if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('voxel_summon_java_'))
   return fs.rm(root,{recursive:true,force:true,maxRetries:3}).catch(()=>{});
 };
 let child;
 try{
  let map='-';if(mappings){map=path.join(root,'client.txt');await fs.writeFile(map,mappings);}
  if(slot.cancelled)throw new Error('原版召唤已停止');
  child=spawn(await javaExe(game.libsRoot,java),['-Xmx768m','-XX:ActiveProcessorCount=4','-cp',cp,path.join(__dirname,'SummonEntity.java'),map,'--summon'],{cwd:root,env:javaEnv(),windowsHide:true});
 }catch(e){await cleanup();throw e;}
 const requests=new Map(),prefix='VOXEL-SUMMON\t';let id=0,closed=false,log='',timer,killTimer,startTimer;
 let started,ready=new Promise((resolve,reject)=>{started={resolve,reject};});
 let done=new Promise(resolve=>child.once('close',()=>{clearTimeout(killTimer);void cleanup().then(resolve);}));
 const error=()=>new Error(`无法启动 Minecraft ${version.id} 的原版召唤。请检查客户端 JAR 和 Java ${java}。${log.trim().split(/\r?\n/).find(l=>/Exception|Error/.test(l))?.replace(/^.*\[STDERR\]: /,'').slice(0,180)??''}`);
 function stop(reason=error()){
  if(!closed){closed=true;clearTimeout(timer);clearTimeout(startTimer);if(summonSession===slot)summonSession=null;
   started.reject(reason);for(const r of requests.values()){clearTimeout(r.timer);r.reject(reason);}requests.clear();
   child.stdin.end();killTimer=setTimeout(()=>{if(child.exitCode===null&&!child.signalCode)child.kill();},1500);killTimer.unref();
  }
  return done;
 }
 slot.stop=()=>stop(new Error('原版召唤已停止'));
 const idle=()=>{clearTimeout(timer);if(!requests.size){timer=setTimeout(()=>stop(new Error('原版召唤进程空闲结束')),90000);timer.unref();}};
 const remember=value=>{log=(log+value+'\n').slice(-5000);};
 child.stderr.on('data',remember);child.stdin.on('error',()=>stop());child.on('error',e=>{remember(e.message);void stop();});child.on('close',()=>{void stop();clearTimeout(killTimer);});
 createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{
  if(closed)return;
  if(!line.startsWith(prefix)){remember(line);return;}
  const [key,kind,value]=line.slice(prefix.length).split('\t');
  if(key==='ready'){clearTimeout(startTimer);idle();started.resolve();return;}
  const pending=requests.get(key);if(!pending)return;
  requests.delete(key);clearTimeout(pending.timer);idle();
  if(kind==='ok'&&value?.length<=350000){pending.resolve(Buffer.from(value,'base64'));return;}
  pending.reject(new Error(value||'原版召唤没有返回有效数据'));
 });
 startTimer=setTimeout(()=>stop(new Error(`Minecraft ${version.id} 原版召唤初始化超时`)),50000);startTimer.unref();
 await ready;
 return {stop,send(entity,pos,snbt){
  if(closed)throw new Error('原版召唤进程已退出，请重试');
  clearTimeout(timer);
  const key=String(++id);
  return new Promise((resolve,reject)=>{
   const deadline=setTimeout(()=>stop(new Error('原版召唤超时')),15000);deadline.unref();
   requests.set(key,{resolve,reject,timer:deadline});child.stdin.write([key,entity,...pos,...(snbt===undefined?[]:[Buffer.from(snbt,'utf8').toString('base64')])].join('\t')+'\n');
  });
 }};
}
async function prepareSummon(jar){
 const game=await gameClasspath(jar);
 if(summonSession?.game!==game){
  void stopSummon();const slot={game};summonSession=slot;
  slot.value=startSummon(slot,game);slot.value.catch(()=>{if(summonSession===slot)summonSession=null;});
 }
 return {game,session:await summonSession.value};
}
async function summonEntity(jar,id,pos,snbt){
 if(typeof id!=='string'||id.length>160||!/^minecraft:[a-z0-9_./-]+$/.test(id))throw new Error('请输入原版实体 ID');
 if(!Array.isArray(pos)||pos.length!==3||!pos.every(Number.isFinite))throw new Error('实体位置无效');
 if(snbt!==undefined&&(typeof snbt!=='string'||Buffer.byteLength(snbt,'utf8')>256*1024||!snbt.trim().startsWith('{')))throw new Error('实体 NBT 必须是长度不超过 256 KiB 的 compound。');
 const {game:{version},session}=await prepareSummon(jar);
 try{return {nbt:await session.send(id,pos,snbt),version:version.id,dv:version.world_version};}
 catch(e){
  if(e.message==='Entity cannot be summoned')throw new Error(`原版 /summon 不支持 ${id}`);
  if(e.message==='Unknown entity type')throw new Error(`${version.id} 没有实体 ${id}`);
  throw new Error(`无法用 ${version.id} 召唤 ${id}：${e.message}`,{cause:e});
 }
}
let collisionCache;
async function collisionShapes(jar){
 const game=await gameClasspath(jar);
 if(collisionCache?.game===game)return collisionCache.data;
 const data=(async()=>{
  const {cp,mappings,version}=game,exe=await javaExe(game.libsRoot,game.java),root=await fs.mkdtemp(path.join(os.tmpdir(),'voxel_shapes_java_'));
  try{
   const output=path.join(root,'shapes.json');
   let map='-';if(mappings){map=path.join(root,'client.txt');await fs.writeFile(map,mappings);}
   await run(exe,['-Xmx768m','-XX:ActiveProcessorCount=4','-cp',cp,path.join(__dirname,'SummonEntity.java'),map,output],{cwd:root,env:javaEnv(),windowsHide:true,timeout:60000});
   if((await fs.stat(output)).size>8*1024*1024)throw new Error('方块形状数据过大');
   return {...JSON.parse(await fs.readFile(output,'utf8')),version:version.id};
  }catch(e){
   const log=String(e.stdout??'')+'\n'+String(e.stderr??'');
   const detail=log.match(/(?:NoSuch(?:Method|Field)Exception|ClassNotFoundException|NoClassDefFoundError): ([^\r\n]+)/)?.[1];
   const hint=/jdk\.compiler not in boot Layer|UnsupportedClassVersionError|class file version/.test(log)?'；当前 Java 不是 JDK（'+exe+' 缺少 javac）':'（'+exe+'）';throw new Error(`无法读取 ${version.id} 方块形状；请检查原版客户端 JAR 和 Java ${game.java}${hint}${detail?'（'+detail+'）':''}`,{cause:e});
  }finally{
   if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('voxel_shapes_java_'))await fs.rm(root,{recursive:true,force:true,maxRetries:3}).catch(()=>{});
  }
 })();
 collisionCache={game,data};data.catch(()=>{if(collisionCache?.data===data)collisionCache=null;});return data;
}
module.exports={summonEntity,prepareSummon,stopSummon,collisionShapes};
