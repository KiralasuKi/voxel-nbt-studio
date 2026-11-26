'use strict';
const schema=require('../media/state-schema.json'),clockwise=require('../media/turn-y.json');
const dirs={east:[1,0,0],west:[-1,0,0],up:[0,1,0],down:[0,-1,0],south:[0,0,1],north:[0,0,-1]};
function rotate(vector,axis,turns){
 const a=(axis+1)%3,b=(axis+2)%3,p=vector.slice();
 for(let i=0;i<turns;i++){const x=p[a];p[a]=-p[b];p[b]=x;}
 return p;
}
function rotateState(state,axis,turns,catalog){
 const spec=(catalog?.schema??schema)[state.name];if(!spec)return {state,limited:true};
 let props={...state.props};
 if(axis===1){
  if(catalog?.turns){
   const rule=catalog.turns[state.name];if(!rule)return {state};
   const [keys,defaults,table]=rule;
   for(let i=turns;i<4;i++){
    const values=keys.map((key,j)=>props[key]??defaults[j]),next=table[values.join(',')];if(!next)continue;
    for(const [j,key] of keys.entries())if(Object.hasOwn(props,key)||next[j]!==defaults[j])props[key]=next[j];
   }
   return {state:{name:state.name,props}};
  }
  // Right-handed +Y is counterclockwise when looking down from above.
  const rules=clockwise[state.name];if(!rules)return {state};
  for(let i=turns;i<4;i++){
   const next={...props};for(const [key,[from,changes]] of Object.entries(rules)){
    const before=props[from]??spec[from].default,after=Object.hasOwn(changes,before)?changes[before]:before;
    if(Object.hasOwn(props,from)||after!==spec[key].default)next[key]=after;else delete next[key];
   }props=next;
  }
  return {state:{name:state.name,props}};
 }
 const direction=d=>{if(!Object.hasOwn(dirs,d))return d;const v=rotate(dirs[d],axis,turns);return Object.keys(dirs).find(k=>dirs[k].every((n,i)=>n===v[i]));};
 const part=(k,transform)=>{if(!Object.hasOwn(spec,k))return true;const before=props[k]??spec[k].default,after=transform(before);if(!spec[k].values.includes(after))return false;
  if(Object.hasOwn(props,k)||after!==spec[k].default)props[k]=after;return true;};
 for(const k of ['axis','horizontal_axis'])if(!part(k,v=>{const i='xyz'.indexOf(v);if(i<0)return v;return 'xyz'[rotate([+(i===0),+(i===1),+(i===2)],axis,turns).findIndex(Boolean)];}))return {state,limited:true};
 const upright=['face','attachment','rotation','shape','hinge','vertical_direction'].some(k=>Object.hasOwn(spec,k))||spec.half?.values.includes('lower')||spec.type?.values.includes('bottom')||(state.name.endsWith('_bed')||state.name.endsWith('chest'));
 let limited=upright;
 if(!upright){for(const k of ['facing','horizontal_facing'])if(!part(k,direction))limited=true;
  if(!part('orientation',v=>v.split('_').map(direction).join('_')))limited=true;
 }
 const faces=Object.keys(dirs).filter(k=>Object.hasOwn(spec,k));
 if(faces.length){
  if(faces.every(k=>Object.hasOwn(spec,direction(k))&&spec[k].values.every(v=>spec[direction(k)].values.includes(v)))){
   for(const k of faces)delete props[k];
   for(const k of faces){const to=direction(k),v=state.props[k]??spec[k].default;if(Object.hasOwn(state.props,k)||v!==spec[to].default)props[to]=v;}
  }else limited=true;
 }
 return {state:{name:state.name,props},limited};
}
const identity=[[1,0,0],[0,1,0],[0,0,1]],orientations=new Map([[String(identity),[]]]),queue=[identity];
for(const axes of queue)for(const axis of [1,0,2])for(const n of [1,2,3]){
 const next=axes.map(a=>rotate(a,axis,n)),key=String(next);
 if(!orientations.has(key)){orientations.set(key,[...orientations.get(String(axes)),[axis,n]]);queue.push(next);}
}
function orientationTurns(axes){
 if(!Array.isArray(axes)||axes.length!==3||axes.some(a=>!Array.isArray(a)||a.length!==3||a.some(v=>![-1,0,1].includes(v)))||!orientations.has(String(axes)))throw new Error('无效的蓝图朝向');
 return orientations.get(String(axes));
}
module.exports={rotate,rotateState,orientationTurns};
