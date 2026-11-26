'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {createHash,randomUUID}=require('node:crypto');const {inflateRawSync}=require('node:zlib');
const safe=/^assets\/[a-z0-9_.-]+\/(?:(?:blockstates|models|items)\/[a-z0-9_./-]+\.json|textures\/(?:block|entity|item|painting)\/[a-z0-9_./-]+\.png)$/;
const paintingVariant=/^data\/([a-z0-9_.-]+)\/painting_variant\/([a-z0-9_./-]+\.json)$/;
const maxFile=8*1024*1024;
function zipEntries(buf,select){
 let end=-1;for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(buf.readUInt32LE(i)===0x06054b50&&i+22+buf.readUInt16LE(i+20)===buf.length){end=i;break;}
 if(end<0||buf.readUInt32LE(end+4)!==0)throw new Error('不是可读取的 Minecraft JAR');
 let at=buf.readUInt32LE(end+16);const count=buf.readUInt16LE(end+10),stop=at+buf.readUInt32LE(end+12),out=[];let total=0;
 if(stop>end||count===65535)throw new Error('不支持分卷或 ZIP64 JAR');
 for(let i=0;i<count;i++){
  if(at+46>stop||buf.readUInt32LE(at)!==0x02014b50)throw new Error('JAR 文件目录损坏');
  const [nl,extra,comment]=[28,30,32].map(n=>buf.readUInt16LE(at+n));const next=at+46+nl+extra+comment;if(next>stop)throw new Error('JAR 条目越界');
  const name=buf.toString('utf8',at+46,at+46+nl);
  if(select(name)&&!name.split('/').some(x=>!x||x==='.'||x==='..')){
   const method=buf.readUInt16LE(at+10),len=buf.readUInt32LE(at+20),raw=buf.readUInt32LE(at+24),p=buf.readUInt32LE(at+42);total+=raw;
   if(raw>maxFile||total>280*1024*1024||raw===0||p+30>stop||buf.readUInt32LE(p)!==0x04034b50||![0,8].includes(method)||(buf.readUInt16LE(at+8)&1))throw new Error('JAR 的资源条目超限或无法读取');
   const start=p+30+buf.readUInt16LE(p+26)+buf.readUInt16LE(p+28);if(start+len>stop)throw new Error('JAR 资源数据越界');
   out.push({name,start,len,raw,method});
  }at=next;
 }
 return out;
}
function jarVersion(buf){
 const entries=zipEntries(buf,name=>name==='version.json');
 if(entries.length!==1||entries[0].raw>64*1024)throw new Error('所选 JAR 缺少有效的原版版本信息');
 const {start,len,raw,method}=entries[0],data=buf.subarray(start,start+len);
 return JSON.parse((method===0?data:inflateRawSync(data,{maxOutputLength:raw})).toString('utf8'));
}
function zipAssets(buf){
 const out=zipEntries(buf,name=>safe.test(name)||paintingVariant.test(name));
 if(!out.some(e=>e.name==='assets/minecraft/blockstates/stone.json')||!out.some(e=>e.name==='assets/minecraft/textures/block/stone.png'))throw new Error('请选择包含原版方块模型及贴图的客户端 JAR，而不是模组或服务端 JAR');
 return out;
}
async function findFolder(folder){
 const base=await fs.realpath(folder);
 for(const p of [base,path.join(base,'assets')])try{await fs.access(path.join(p,'minecraft','blockstates','stone.json'));await fs.access(path.join(p,'minecraft','textures','block','stone.png'));return p;}catch{}
 throw new Error('未找到 minecraft/blockstates 和 textures/block；请选择 assets 或包含 assets 的文件夹');
}
async function jarFolder(file,storage){
 const p=await fs.realpath(file),stat=await fs.stat(p);if(!stat.isFile()||stat.size>256*1024*1024)throw new Error('JAR 大小超过 256 MiB 或不是文件');
 const cache=path.join(storage,'vanilla-v2-'+createHash('sha256').update(`${p}\0${stat.size}\0${stat.mtimeMs}`).digest('hex').slice(0,28));
 try{return await findFolder(path.join(cache,'assets'));}catch{}
 const buf=await fs.readFile(p),entries=zipAssets(buf).map(entry=>{
  const variant=paintingVariant.exec(entry.name);
  return variant?{...entry,name:`assets/${variant[1]}/painting_variant/${variant[2]}`}:entry;
 });const tmp=path.join(storage,'.extract-'+randomUUID());await fs.mkdir(tmp,{recursive:true});
 try{
  const dirs=new Set();for(const e of entries)dirs.add(path.dirname(e.name));
  await Promise.all([...dirs].map(dir=>fs.mkdir(path.join(tmp,dir),{recursive:true})));
  let i=0;await Promise.all(Array.from({length:12},async()=>{while(i<entries.length){const e=entries[i++],raw=buf.subarray(e.start,e.start+e.len),data=e.method===0?raw:inflateRawSync(raw,{maxOutputLength:e.raw});
   if(data.length!==e.raw)throw new Error('JAR 资源长度不匹配');await fs.writeFile(path.join(tmp,e.name),data,{flag:'wx'});
  }}));
  try{await fs.rename(tmp,cache);}catch(e){await findFolder(path.join(cache,'assets')).catch(()=>{throw e;});}
  return findFolder(path.join(cache,'assets'));
 }finally{
  const resolved=path.resolve(tmp),root=path.resolve(storage);if(path.dirname(resolved)===root&&path.basename(resolved).startsWith('.extract-'))await fs.rm(resolved,{recursive:true,force:true}).catch(()=>{});
 }
}
const maskTag=/^data\/minecraft\/tags\/(block|blocks|fluid|fluids)\/([a-z0-9_./-]+)\.json$/;
async function jarMaskData(file){
 const p=await fs.realpath(file),st=await fs.stat(p);
 if(!st.isFile()||st.size>256*1024*1024)throw new Error('JAR 大小超过 256 MiB 或不是文件');
 const buf=await fs.readFile(p),entries=zipEntries(buf,n=>n==='version.json'||maskTag.test(n));
 const tags={block:Object.create(null),fluid:Object.create(null)};let version={},total=0;
 for(const e of entries){
  total+=e.raw;if(e.raw>256*1024||total>8*1024*1024)throw new Error('JAR 标签数据超过大小限制');
  const raw=buf.subarray(e.start,e.start+e.len),data=e.method===0?raw:inflateRawSync(raw,{maxOutputLength:e.raw});
  if(data.length!==e.raw)throw new Error('JAR 标签数据不完整');
  const parsed=JSON.parse(data.toString('utf8'));
  if(e.name==='version.json'){version=parsed;continue;}
  const [,type,key]=maskTag.exec(e.name);
  if(!Array.isArray(parsed?.values))throw new Error(`JAR 标签缺少 values：${key}`);
  tags[type.startsWith('block')?'block':'fluid']['minecraft:'+key]=parsed.values;
 }
 return {tags,version:version.id||version.name||'未知版本',dataVersion:version.world_version??null};
}
let versionCache;
async function readJarVersion(file){
 const p=await fs.realpath(file),st=await fs.stat(p);
 if(!st.isFile()||st.size>256*1024*1024)throw new Error('JAR 大小超过 256 MiB 或不是文件');
 const key=[p,st.size,st.mtimeMs,st.ctimeMs].join('|');
 if(versionCache?.key!==key){
  const data=fs.readFile(p).then(jarVersion);versionCache={key,data};
  data.catch(()=>{if(versionCache?.data===data)versionCache=null;});
 }
 return versionCache.data;
}
module.exports={jarVersion,readJarVersion,zipAssets,jarFolder,jarMaskData};
