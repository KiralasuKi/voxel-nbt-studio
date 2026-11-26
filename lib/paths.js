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
function librariesRoot(file){
 const start=path.dirname(path.resolve(file));
 for(const dir of [start,...hints,process.cwd()]){const hit=find(dir);if(hit)return hit;}
 return path.resolve(start,'..','..','libraries');
}
module.exports={addHint,librariesRoot,isLibraries};
