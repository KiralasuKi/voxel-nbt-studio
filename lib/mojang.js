'use strict';
const fs=require('node:fs/promises');
const {createHash}=require('node:crypto');
const MANIFEST='https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const official=new Set(['piston-meta.mojang.com','piston-data.mojang.com','launchermeta.mojang.com','launcher.mojang.com','libraries.minecraft.net']);
const sha1=/^[0-9a-f]{40}$/;
const hash=data=>createHash('sha1').update(data).digest('hex');
const supported=id=>typeof id==='string'&&/^(?:1\.21(?:\.\d+)?|26\.[12](?:\.\d+)?|26\.3)$/.test(id);

// Official manifest checksums allow matching previously downloaded clients offline.
const releases=new Map([
 [3953,['1.21','0e9a07b9bb3390602f977073aa12884a4ce12431']],
 [3955,['1.21.1','30c73b1c5da787909b2f73340419fdf13b9def88']],
 [4080,['1.21.2','c7ac2d0d86f4ca416cab9064ff8a281852ad0c7b']],
 [4082,['1.21.3','6f67d19b4467240639cb2c368ffd4b94ba889705']],
 [4189,['1.21.4','a7e5a6024bfd3cd614625aa05629adf760020304']],
 [4325,['1.21.5','b88808bbb3da8d9f453694b5d8f74a3396f1a533']],
 [4435,['1.21.6','740a125b83dd3447feaa3c5e891ead7fbb21ae28']],
 [4438,['1.21.7','a2db1ea98c37b2d00c83f6867fb8bb581a593e07']],
 [4440,['1.21.8','a19d9badbea944a4369fd0059e53bf7286597576']],
 [4554,['1.21.9','ce92fd8d1b2460c41ceda07ae7b3fe863a80d045']],
 [4556,['1.21.10','d3bdf582a7fa723ce199f3665588dcfe6bf9aca8']],
 [4671,['1.21.11','ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd']],
 [4786,['26.1','191771837687b766537a8c4607cb6fad79c533a1']],
 [4788,['26.1.1','377031a9e733ba8ab4d355959a8f6fb8eb707556']],
 [4790,['26.1.2','4e618f09a0c649dde3fdf829df443ce0b8831e65']],
 [4903,['26.2','2dc72797acbc1b63fc16a11c4ac393605f453754']],
 [5023,['26.3','e877b6a07acd633fb3bb475002175cec036e7b87']],
]);
const matchingClientVersion=dv=>releases.get(dv)?.[0];
const upgradeVersions=dv=>[...releases].filter(([target])=>target>dv).map(([target,[version]])=>({label:version,dv:target})).reverse();
async function isCachedClient(dv,file){
 const expected=releases.get(dv)?.[1];if(!expected)return false;
 const info=await fs.stat(file).catch(()=>null);
 return Boolean(info?.isFile()&&info.size<=256*1024*1024&&await fs.readFile(file).then(data=>hash(data)===expected).catch(()=>false));
}

async function officialDownload(url,max,digest,{signal,timeout=18000}={}){
 const u=new URL(url);
 if(u.protocol!=='https:'||!official.has(u.host)||u.username||u.password)throw new Error('无法验证原版资源来源');
 for(let attempt=0;;attempt++){
  signal?.throwIfAborted();
  try{
   const timer=AbortSignal.timeout(timeout);
   const r=await fetch(u,{signal:signal?AbortSignal.any([signal,timer]):timer,redirect:'error'});
   if(!r.ok)throw new Error('Mojang 下载失败：HTTP '+r.status);
   let count=0;const chunks=[];
   for await(const chunk of r.body){count+=chunk.length;if(count>max)throw new Error('Mojang 下载超过大小限制');chunks.push(chunk);}
   const b=Buffer.concat(chunks,count);if(digest&&hash(b)!==digest)throw new Error('Mojang 下载校验失败');return b;
  }catch(e){
   const transient=e.name==='TimeoutError'||['UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(e.cause?.code??e.code);
   if(attempt||signal?.aborted||!transient)throw e;
  }
 }
}
let manifest;
function versions(){
 if(!manifest)manifest=officialDownload(MANIFEST,4*1024*1024).then(data=>{
  const {versions}=JSON.parse(data);if(!Array.isArray(versions))throw new Error('无法读取 Mojang 版本清单');return versions;
 }).catch(e=>{manifest=null;throw e;});
 return manifest;
}
async function versionMetadata(id,{releaseOnly=false,signal}={}){
 const row=(await versions()).find(v=>v.id===id&&(!releaseOnly||v.type==='release'));
 if(!sha1.test(row?.sha1??''))throw new Error('官方版本清单没有 '+id);
 const meta=JSON.parse(await officialDownload(row.url,4*1024*1024,row.sha1,{signal}));
 if(meta.id!==id)throw new Error('Mojang 版本信息与所选版本不符');
 return meta;
}
async function clientVersions(){
 return [...new Set((await versions()).filter(v=>v.type==='release'&&supported(v.id)).map(v=>v.id))]
  .sort((a,b)=>b.localeCompare(a,'en',{numeric:true}));
}
const validArtifact=a=>sha1.test(a?.sha1??'')&&Number.isSafeInteger(a.size)&&a.size>0&&a.size<=256*1024*1024;
function libraryArtifacts(meta){
 const artifacts=new Map();
 for(const lib of meta.libraries??[]){
  const a=lib.downloads?.artifact;
  if(!validArtifact(a)||typeof a.path!=='string'||!(/^(?:[A-Za-z0-9_.+-]+\/)+[A-Za-z0-9_.+-]+\.jar$/.test(a.path))||
     a.path.split('/').some(x=>x.endsWith('.')||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(x))||a.path.includes('-natives-'))continue;
  artifacts.set(a.path,a);
 }
 return [...artifacts.values()];
}
async function readCachedArtifact(file,artifact){
 if(!validArtifact(artifact))return null;
 const stat=await fs.stat(file).catch(e=>{if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;});
 if(!stat?.isFile()||stat.size!==artifact.size)return null;
 const data=await fs.readFile(file);return hash(data)===artifact.sha1?data:null;
}
async function downloadArtifact(artifact,file,signal){
 if(!validArtifact(artifact))throw new Error('官方下载信息无效');
 signal?.throwIfAborted();
 if(await readCachedArtifact(file,artifact))return null;
 const data=await officialDownload(artifact.url,artifact.size,artifact.sha1,{signal,timeout:180000});
 if(data.length!==artifact.size)throw new Error('Mojang 下载不完整');
 return data;
}
async function downloadClient(id,file,signal,meta){
 if(!supported(id))throw new Error('仅支持 Minecraft Java 1.21 至 26.3 正式版');
 meta??=await versionMetadata(id,{releaseOnly:true,signal});
 if(meta.id!==id)throw new Error('Mojang 版本信息与所选版本不符');
 return downloadArtifact(meta.downloads?.client,file,signal);
}
module.exports={officialDownload,versionMetadata,clientVersions,downloadClient,matchingClientVersion,upgradeVersions,isCachedClient,libraryArtifacts,readCachedArtifact,downloadArtifact};
