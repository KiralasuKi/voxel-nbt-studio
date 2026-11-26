'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {javaExe}=require('./java-runtime');
const {gameClasspath,javaEnv}=require('./native-summon');
const run=promisify(execFile);
async function runCatalog(game,prefix,args,writeInput){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
 try{
  const output=path.join(root,'result.json');
  let mapping='-';if(game.mappings){mapping=path.join(root,'client.txt');await fs.writeFile(mapping,game.mappings);}
  const input=await writeInput?.(root);
  const [entry,...params]=args(mapping,output,input);
  const exe=await javaExe(game.java);
  await run(exe,['-Xmx768m','-XX:ActiveProcessorCount=4','-cp',game.cp,path.join(__dirname,entry),...params],{cwd:root,env:javaEnv(),windowsHide:true,timeout:60000});
  if((await fs.stat(output)).size>12*1024*1024)throw new Error('原版模型或调色板数据过大');
  return JSON.parse(await fs.readFile(output,'utf8'));
 }catch(e){
  const log=String(e.stdout??'')+'\n'+String(e.stderr??'');
  const reason=log.match(/(?:Caused by: )?(?:java\.lang\.)?(?:NoSuchMethodException|NoSuchFieldException|ClassNotFoundException|NoClassDefFoundError|IllegalStateException): [^\r\n]+/)?.[0];
  throw new Error(`读取 Minecraft ${game.version.id} 的原版模型或调色板失败。${reason??(e.stdout||e.stderr?'请确认原版依赖完整。':e.message)}`,{cause:e});
 }finally{
  if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith(prefix))await fs.rm(root,{recursive:true,force:true,maxRetries:3}).catch(()=>{});
 }
}
async function normalizeLegacy(jar,version,states){
 if(!states.length)return [];
 return runCatalog(await gameClasspath(jar),'voxel_mask_java_',
  (mapping,output,input)=>['SummonEntity.java',mapping,'--palette',input,output],async root=>{
   const input=path.join(root,'palette.json');await fs.writeFile(input,JSON.stringify({version,states}));return input;
  });
}
let entityCache;
async function entityModels(jar){
 const game=await gameClasspath(jar);
 if(entityCache?.game!==game){
  const exact=game.version.world_version===5023&&!game.mappings;
  const data=runCatalog(game,'voxel_entity_java_',(mapping,output)=>exact?['EntityModels.java',output]:['SummonEntity.java',mapping,'--models',output,game.file])
   .then(result=>({...result,approximate:!exact}));
  entityCache={game,data};data.catch(()=>{if(entityCache?.data===data)entityCache=null;});
 }
 return entityCache.data;
}
module.exports={normalizeLegacy,entityModels};
