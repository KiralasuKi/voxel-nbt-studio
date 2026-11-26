'use strict';
const { parentPort } = require('node:worker_threads');
const { readFile, stat } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { Structure, dimensions, MAX_EDIT } = require('./nbt');
const {normalizeLegacy}=require('./mask-java');
const {addHint}=require('./paths');
let gameCatalog;
function bindCatalog(){doc.gameCatalog=doc.dv===gameCatalog?.dataVersion?gameCatalog:null;}
let doc, layouts=[], cursor=0, sequence=0, maskCatalog, maskRequest=0;
const maskModule=()=>import('../media/mask.js');
const hash = b => createHash('sha256').update(b).digest('hex');
async function load(path) {
  if ((await stat(path)).size > 256*1024*1024) throw new Error('文件超过 256 MiB');
  return readFile(path);
}
const bytes=d=>d.b.length+(d.original?.length??0)+d.index.byteLength+d.blockCell.byteLength*3;
function checkLayout(size){
  if(bytes(cursor?layouts[0].before:doc)+size+layouts.slice(0,cursor).reduce((m,x)=>m+bytes(x.after),0)>672*1024*1024)throw new Error('结构操作的撤销内存不足。请先保存并重新打开模板。');
}
function rememberLayout(after,oldPalette,newPalette){
  const token=++sequence;layouts.length=cursor;layouts.push({before:doc,after,token,oldPalette,newPalette});cursor++;doc=after;bindCatalog();return token;
}
function growth(q){
  const lo=[0,0,0],hi=doc.size.map(n=>n-1);
  const include=p=>{
    if(!Array.isArray(p)||p.length!==3||!p.every(n=>Number.isSafeInteger(n)&&Math.abs(n)<=8192))throw new Error('无效的编辑坐标');
    for(let i=0;i<3;i++){lo[i]=Math.min(lo[i],p[i]);hi[i]=Math.max(hi[i],p[i]);}
  };
  if(q.tool==='place'&&!q.box){
    if(!Array.isArray(q.points)||q.points.length>MAX_EDIT)throw new Error('无效的编辑坐标');
    for(const p of q.points){
      include(p);if(q.mx)include([doc.size[0]-1-p[0],p[1],p[2]]);if(q.mz)include([p[0],p[1],doc.size[2]-1-p[2]]);
    }
  }else if(q.tool==='extrude'){
    if(!Array.isArray(q.delta)||q.delta.length!==3||!q.delta.every(Number.isSafeInteger)||q.delta.filter(Boolean).length!==1)return null;
    if(!Array.isArray(q.selection)||!q.selection.length||q.selection.length>MAX_EDIT)return null;
    for(const c of q.selection){if(!Number.isInteger(c)||c<0||c>=doc.volume)throw new Error('无效的选区坐标');if(doc.at(c))include(doc.pos(c).map((v,i)=>v+q.delta[i]));}
  }else return null;
  const size=hi.map((v,i)=>v-lo[i]+1);
  return size.some((v,i)=>v!==doc.size[i])?{size,offset:lo.map(n=>0-n)}:null;
}
parentPort.on('message',async ({id,method,args})=>{
  try {
    let result;
    switch(method){
      case 'load': {maskRequest++;maskCatalog=null;const original=await load(args[0]);doc=await Structure.open(args[1]?await load(args[1]):original);layouts=[];cursor=0;maskCatalog=null;bindCatalog();result=hash(original);break;}
      case 'view':result=doc.snapshot(args[0]);break;
      case 'snbt':result=doc.snbt();break;
      case 'gameCatalog':gameCatalog=args[0];bindCatalog();break;
      case 'maskCatalog':{
        const [base,jar,roots]=args,request=++maskRequest;maskCatalog=null;
        addHint(roots);
        const version=doc.dv??500;
        if(base.traits&&jar&&version<base.dataVersion){
          const {maskStateKey}=await maskModule(),raw=new Map();
          for(const pal of doc.palettes)if(!pal.modern)for(const st of pal.states)raw.set(maskStateKey(st),st);
          if(raw.size>65536)throw new Error('旧版调色板状态过多，无法升级掩码');
          const fixed=await normalizeLegacy(jar,version,[...raw.values()]);const legacy=Object.create(null);let i=0;
          for(const key of raw.keys()){const st=fixed[i++];if(maskStateKey(st)!==key)legacy[key]=st;}
          result=legacy;
        }
        if(request!==maskRequest)throw new Error('结构或 JAR 已变更，请重试');
        maskCatalog=result?{...base,legacy:result}:base;break;
      }
      case 'copySelection':result=doc.copySelection(...args);break;
      case 'headProfiles':result=args[0].map(i=>[i,doc.headProfile(i,args[1])??null]);break;
      case 'entityRows':result={entities:doc.entities,entityList:doc.entityList()};break;
      case 'entityBounds':doc.entityBounds(args[0]);result=doc.dv;break;
      case 'entityDetails':result=doc.entityDetails(args[0]);break;
      case 'copyEntity':result=doc.copyEntity(args[0]);break;
      case 'edit':{
        let q=args[0],filter,checkMask,expand=growth(q);const before=doc,clip=args[1];
        if(q.tool==='paste'&&clip?.entities?.length&&(clip.entityOnly||q.placeEntities!==false)){
          // Stage both halves on a fork; a conflict in either half leaves the live document untouched.
          const staged=new Structure(null,before.pasteEntities(clip,q.origin,q.axes),before.zip);staged.gameCatalog=before.gameCatalog;
          const placement=clip.blocks.length?staged.paste(clip,q.origin,q.axes,{...q,allowEmpty:true}):null;
          const raw=staged.raw(true);checkLayout(raw.length*1.5);
          const after=new Structure(null,raw,before.zip);
          result={token:rememberLayout(after,q.palette,q.palette),selection:placement?.selection,entityOnly:!clip.blocks.length};break;
        }
        const maskSpec=q.blockFilter?.tag===true?{type:'matching_blocks',blocks:'#'+q.blockFilter.name}:q.mask;
        if(maskSpec!==undefined){
          if(!['paint','place','fill'].includes(q.tool))throw new Error('只有涂刷、放置和框填可以使用掩码');
          const {compileMask,maskAir,maskWorkLimit}=await maskModule(),mask=compileMask(maskSpec,maskCatalog);
          const [w,h,d]=doc.size,p=Number.isInteger(q.palette)&&doc.palettes[q.palette]?q.palette:0;
          const get=(x,y,z)=>x<0||y<0||z<0||x>=w||y>=h||z>=d?maskAir:doc.state((doc.at(x+w*(z+d*y))>>1)-1,p)||maskAir;
          checkMask=(point,total)=>{if(total*mask.cost>maskWorkLimit)throw new Error('掩码与选区组合过大，请缩小选区或简化谓词');return mask.test(get,h,...point);};
          filter=(document,cell,palette,total)=>checkMask(document.pos(cell),total);
        }
        if(expand&&q.tool==='place'){
          const goals=new Map();for(const [x,y,z] of q.points)for(const u of q.mx?[x,before.size[0]-1-x]:[x])for(const v of q.mz?[z,before.size[2]-1-z]:[z]){
            goals.set(`${u},${y},${v}`,[u,y,v]);if(goals.size>MAX_EDIT)throw new Error('单次编辑过大');
          }
          const points=[...goals.values()].filter(p=>!checkMask||checkMask(p,goals.size));
          q={...q,points,mx:false,mz:false};filter=undefined;expand=growth(q);
        }
        if(expand){
          const {size,offset}=expand,shift=p=>p.map((v,i)=>v+offset[i]);
          checkLayout(dimensions(size)*4+before.b.length*1.5);
          const after=before.grow(size,offset);
          if(q.tool==='place')q={...q,points:q.points.map(shift)};
          else q={...q,selection:q.selection.map(c=>after.cell(shift(before.pos(c))))};
          result=after.edit(q,filter);
          // A masked or no-op edit must not grow the structure.
          if(result.changes.length){
            result={token:rememberLayout(after,q.palette,q.palette),offset,size,selection:result.selection,skipped:result.skipped};
          }
        }else{
          result=q.tool==='paste'?doc.paste(args[1],q.origin,q.axes,q):doc.edit(q,filter);if(result.changes.length||result.entityChanges?.length)layouts.length=cursor;
        }
        break;
      }
      case 'layout': {
        const q=args[0];
        const next=doc.layout(q);if(!next||next.confirm){result=next;break;}
        checkLayout(next.raw.length*1.5);
        const after=new Structure(null,next.raw,doc.zip);
        result={token:rememberLayout(after,q.palette,next.active),active:next.active,removed:next.removed,entity:next.entity};break;
      }
      case 'restoreLayout':{
        const [token,redo]=args,entry=layouts[redo?cursor:cursor-1];
        if(entry?.token!==token)throw new Error('无法恢复该次模板操作');
        cursor+=redo?1:-1;doc=redo?entry.after:entry.before;bindCatalog();result=redo?entry.newPalette:entry.oldPalette;break;
      }
      case 'apply':result=doc.apply(...args);break;
      case 'inspect':result=doc.tileInfo(args[0]);break;
      case 'tileValue':result=doc.tileValue(...args);break;
      case 'save': {const data=await doc.serialize();result={data,hash:hash(data)};break;}
      default:throw new Error('未知请求');
    }
    parentPort.postMessage({id,result});
  } catch(e){parentPort.postMessage({id,error:e.message||String(e)});}
});
