'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {atomicFile}=require('./document');
const {versionMetadata,libraryArtifacts,downloadClient,downloadArtifact,upgradeVersions}=require('./mojang');
const marker=file=>path.join(path.dirname(file),'.voxel-dependencies-v1');
const officialJarPath=(storage,version)=>path.join(storage,'versions',version,`${version}.jar`);
const dependenciesInstalled=file=>fs.access(marker(file)).then(()=>true,()=>false);

async function installOfficialClient(storage,version,signal,report=()=>{}){
 if(!upgradeVersions(0).some(v=>v.label===version))throw new Error('不支持的 Minecraft 正式版');
 const file=officialJarPath(storage,version),meta=await versionMetadata(version,{releaseOnly:true,signal});
 const artifacts=libraryArtifacts(meta);
 if(!artifacts.length)throw new Error('未找到 Mojang 客户端依赖清单');
 const map=meta.downloads?.client_mappings;
 const jobs=[[file,null],...artifacts.map(a=>[path.join(storage,'libraries',a.path),a])];
 if(map)jobs.push([path.join(path.dirname(file),'client-mappings.txt'),map]);
 const internal=new AbortController(),active=signal?AbortSignal.any([signal,internal.signal]):internal.signal;
 let next=0,done=0;
 await Promise.allSettled(Array.from({length:4},async()=>{
  try{
   while(next<jobs.length){
    active.throwIfAborted();
    const [target,artifact]=jobs[next++];
    const data=artifact?await downloadArtifact(artifact,target,active):await downloadClient(version,file,active,meta);
    if(data){await fs.mkdir(path.dirname(target),{recursive:true});active.throwIfAborted();await atomicFile(target,data);}
    report({increment:100/jobs.length,message:`已校验 ${++done}/${jobs.length} 个文件`});
   }
  }catch(e){internal.abort(e);throw e;}
 }));
 active.throwIfAborted();
 await atomicFile(marker(file),Buffer.from('完整\n','utf8'));
 return file;
}
module.exports={installOfficialClient,officialJarPath,dependenciesInstalled};
