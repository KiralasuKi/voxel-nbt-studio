'use strict';
const path=require('node:path');
const {existsSync}=require('node:fs');
const hints=[];
function addHint(dir){
 for(const d of Array.isArray(dir)?dir:[dir]){
  if(typeof d!=='string'||!d||!path.isAbsolute(d))continue;
  const p=path.resolve(d);if(!hints.includes(p))hints.push(p);
 }
}
function isLibraries(dir){
 return existsSync(path.join(dir,'com','mojang'))&&existsSync(path.join(dir,'com','google'));
}
function find(dir){
 for(let cur=path.resolve(dir),i=0;i<12;i++,cur=path.dirname(cur)){
  if(isLibraries(cur))return cur;
  if(isLibraries(path.join(cur,'libraries')))return path.join(cur,'libraries');
  if(path.dirname(cur)===cur)break;
 }
 return null;
}
function librariesRoots(file){
 const start=path.dirname(path.resolve(file));
 const explicit=(process.env.VOXEL_LIBRARIES??'').split(path.delimiter).filter(p=>path.isAbsolute(p));
 return [...new Set([...explicit,...[start,...hints,process.cwd()].map(find).filter(Boolean),path.resolve(start,'..','..','libraries')])];
}
module.exports={addHint,librariesRoots};
