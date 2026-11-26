'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {existsSync}=require('node:fs');
const {javaExe}=require('./java-runtime');
const pins=require('./mask-java.json'),run=promisify(execFile);
let verified;
const {librariesRoot,addHint}=require('./paths');
async function classpath(jar){
 const file=await fs.realpath(jar),stat=await fs.stat(file);
 const key=file+'|'+stat.mtimeMs+'|'+stat.size;
 if(verified?.key===key)return verified.value;
 const value=(async()=>{
  const root=librariesRoot(file);
  const entries=[[file,pins.client],...Object.entries(pins.libraries).map(([p,h])=>[path.join(root,p),h])];
  for(const [p,hash] of entries){
   if(p.includes(path.delimiter)||p.includes('*')||(await fs.stat(p)).size>256*1024*1024)throw new Error('JAR 或类路径无效');
   const digest=createHash('sha256').update(await fs.readFile(p)).digest('hex');
   if(digest!==hash)throw new Error('只运行校验通过的原版 Minecraft 26.3 JAR 和依赖库');
  }
  return {cp:entries.map(([p])=>p).join(path.delimiter),libsRoot:root};
 })();
 verified={key,value};value.catch(()=>{if(verified?.value===value)verified=null;});return value;
}
async function normalizeLegacy(jar,version,states){
 if(!states.length)return [];
 let cp,libsRoot;try{({cp,libsRoot}=await classpath(jar));}catch(e){throw new Error('旧版 NBT 掩码需要从游戏安装目录选择完整的原版 26.3 客户端 JAR：'+e.message);}
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'voxel_mask_java_'));
 try{
  const input=path.join(root,'palette.json'),output=path.join(root,'fixed.json');
  await fs.writeFile(input,JSON.stringify({version,states}));
  const env={...process.env};for(const key of Object.keys(env))if(/^(JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i.test(key))delete env[key];
  await run(await javaExe(libsRoot,25),['-Xmx768m','-cp',cp,path.join(__dirname,'MaskPalette.java'),input,output],{cwd:root,env,windowsHide:true,timeout:60000});
  return JSON.parse(await fs.readFile(output,'utf8'));
 }catch(e){throw new Error('无法用原版升级掩码调色板；请确认 PATH 中可运行 Java 25。'+(e.code?' ('+e.code+')':''));}
 finally{if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('voxel_mask_java_'))await fs.rm(root,{recursive:true,force:true,maxRetries:3}).catch(()=>{});}
}
let entityCache;
async function entityModels(jar){
 const {cp,libsRoot}=await classpath(jar);
 if(entityCache?.cp!==cp){
  const data=(async()=>{
   const root=await fs.mkdtemp(path.join(os.tmpdir(),'voxel_entity_java_'));
   try{
    const output=path.join(root,'models.json'),env={...process.env};
    for(const key of Object.keys(env))if(/^(JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i.test(key))delete env[key];
    await run(await javaExe(libsRoot,25),['-Xmx768m','-cp',cp,path.join(__dirname,'EntityModels.java'),output],{cwd:root,env,windowsHide:true,timeout:60000});
    if((await fs.stat(output)).size>12*1024*1024)throw new Error('实体模型数据过大');
    return JSON.parse(await fs.readFile(output,'utf8'));
   }finally{if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('voxel_entity_java_'))await fs.rm(root,{recursive:true,force:true}).catch(()=>{});}
  })();
  entityCache={cp,data};data.catch(()=>{if(entityCache?.data===data)entityCache=null;});
 }
 return entityCache.data;
}
module.exports={normalizeLegacy,entityModels};
