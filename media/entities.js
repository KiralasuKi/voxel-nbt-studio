import {createNbtTree} from './nbt-tree.js';
import {bindNbtCompletion} from './nbt-completion.js';
import {avatar,skinImage} from './player-skins.js';
import {createHangingModels,hangingBasis,frameHalfSize} from './hanging-models.js';
const $=id=>document.getElementById(id);
function projectMatrix(m,pos,basis){
 const col=(v,w)=>Array.from({length:4},(_,i)=>v.reduce((s,x,j)=>s+x*m[j*4+i],w*m[12+i]));
 return new Float32Array([...basis.flatMap(a=>col(a,0)),...col(pos,1)]);
}
const axesOf=([yaw,pitch])=>{
 const a=-yaw*Math.PI/180,c=Math.cos(a),s=Math.sin(a),p=pitch*Math.PI/180,u=Math.sin(p),v=Math.cos(p);
 return [[c,0,-s],[s*u,v,c*u],[s*v,-u,c*v]];
};
const axisTransform=(axes,p)=>[0,1,2].map(i=>axes.reduce((n,a,j)=>n+a[i]*p[j],0));
export function entityModelAxes({rotation,rotationMode,hanging},templateAxes,turn=0){
 if(rotationMode==='fixed')return axesOf([0,0]);
 const angles=rotationMode==='cardinal'?[(Math.floor(rotation[0]/90+.5)&3)*90,0]:rotation;
 const basis=hanging?hangingBasis(hanging.facing).map(axis=>turn?axisTransform(axesOf([turn,0]),axis):axis):axesOf(angles);
 return templateAxes?basis.map(axis=>axisTransform(templateAxes,axis)):basis;
}
const format=p=>p.map(n=>Number(n.toFixed(4))).join(', ');
export function entityBox(row,sizes,hangingModel,basis){
 if(row.hanging){
  const half=hangingModel?.half??frameHalfSize(row.hanging.item),axes=basis??hangingBasis(row.hanging.facing);
  const extents=row.pos.map((_,i)=>axes.reduce((n,a,j)=>n+Math.abs(a[i])*half[j],0));
  return {lo:row.pos.map((v,i)=>v-extents[i]),hi:row.pos.map((v,i)=>v+extents[i])};
 }
 const [w,h]=sizes&&Object.hasOwn(sizes,row.id)?sizes[row.id]:[.64,1.8];
 const [x,y,z]=row.pos,r=(w||.25)/2;
 return {lo:[x-r,y,z-r],hi:[x+r,y+(h||.25),z+r]};
}
export function rayBox({eye,d},lo,hi){let a=0,b=Infinity;for(let i=0;i<3;i++){
 if(Math.abs(d[i])<1e-8){if(eye[i]<lo[i]||eye[i]>hi[i])return Infinity;continue;}
 const x=(lo[i]-eye[i])/d[i],y=(hi[i]-eye[i])/d[i];a=Math.max(a,Math.min(x,y));b=Math.min(b,Math.max(x,y));if(a>b)return Infinity;
 }return a;}
export function createEntities({vscode,edit,blocked,onPick,onSelect,onVisibilityChange,draftPosition,notify,dirty,gl,bind,sampleEntityTexture,skinPass,root,schema,skins}){
 let rows=[],catalog=null,chosen=null,details=null,jar=false,picking=false,error=null;
 const meshes=new Map(),textures=new Map(),hangingModel=createHangingModels(root,()=>{status();dirty();});
 const panel=createNbtTree({prefix:'entity',scope:'entity',schema,blocked:()=>blocked(),apply:fields=>submit('nbt',{fields})});
 bindNbtCompletion($('entitySnbt'),()=>{const ctx=schema?.(details?.dv);return ctx&&details?{ctx,root:'entity',id:details.id,forbid:['Pos']}:null;});
 bindNbtCompletion($('entityId'),()=>{const ctx=schema?.();return ctx?{ctx,root:'entity',path:['id'],base:{},stringInput:true}:null;});
 function selected(){return rows.find(r=>r.index===chosen);}
 function inRegion({lo,hi}){return rows.filter(r=>r.pos.every((v,i)=>v>=lo[i]&&v<hi[i]+1));}
 function matchGroup(previous,indices){
  if(indices){const wanted=new Set(indices);return rows.filter(r=>wanted.has(r.index));}
  const wanted=new Map(previous.map(r=>[r.index,r.revision]));
  return rows.filter(r=>wanted.get(r.index)===r.revision);
 }
 function buttons(){
  const row=selected(),lock=blocked(),ready=!!row;
  $('entityMotionHint').textContent=row?.rotationMode==='cardinal'?'坐垫只按四个水平方向显示。拖箭头平移，Esc 取消。':row?.rotationMode==='hanging'?'挂饰由 NBT 的朝向决定。可拖箭头平移。':row?.rotationMode==='fixed'?'此实体的外观不随朝向旋转。拖箭头平移，Esc 取消。':'在查看或取样模式下可点选实体。拖箭头平移，拖绿环水平旋转，Esc 取消。';
  $('entityCopy').disabled=lock||!ready;$('entityMove').disabled=lock||!ready;$('entityDelete').disabled=lock||!ready;
  $('entityCreate').disabled=lock||!jar;
  $('entityCreateInfo').textContent=!jar?'选择原版客户端 JAR 后可按 /summon 新增实体。':'使用位置栏的坐标，按所选 JAR 的版本初始化实体。';$('entityPickPos').disabled=lock;$('entityApplySnbt').disabled=lock||!details;
  $('entityPickPos').setAttribute('aria-pressed',String(picking));panel.buttons();
 }
 function status(){
  const active=selected(),mesh=active&&(active.hanging?hangingModel(active)?.parts.length:modelFor(active));
  $('entityStatus').textContent=picking?'点击方块表面或工作层填写位置，Esc 取消。':!jar?'选择客户端 JAR 后启用实体预览；仍可编辑数据。':error||(!catalog?'正在读取原版实体模型…':active&&!mesh?'该类型没有可离线绘制的原版模型，显示占位框。':`${rows.length} 个可编辑实体 · ${catalog.approximate?'原版静态模型（简化）':'原版静态模型'}`);
 }
 function setJar(on){jar=on;$('renderEntities').disabled=!on;status();buttons();onVisibilityChange(visible());dirty();}
 function setCatalog(data,message){catalog=data;error=message;$('entityIds').replaceChildren(...(data?.types??[]).map(id=>Object.assign(document.createElement('option'),{value:id})));status();dirty();}
 function clearDetails(){details=null;$('entityEditor').hidden=true;$('entitySnbt').value='';panel.load(null);}
 function setRows(list){
  const count=rows.length,revision=selected()?.revision;rows=list??[];
  if(rows.length<count&&selected()?.revision!==revision)chosen=null;
  const prev=selected();
  const select=$('entityList');select.replaceChildren(Object.assign(document.createElement('option'),{value:'',textContent:'选择实体…'}),...rows.map(r=>Object.assign(document.createElement('option'),{value:r.index,textContent:`#${r.index+1} ${r.id} · ${format(r.pos)}`})));
  if(prev){select.value=String(chosen);if(!details||prev.revision!==details.revision)choose(chosen);}
  else{chosen=null;clearDetails();$('entityPos').value=format(draftPosition());}status();buttons();dirty();
 }
 function choose(index){
  chosen=index;const r=selected();$('entityList').value=r?String(index):'';clearDetails();
  $('entityPos').value=format(r?.pos??draftPosition());
  if(r)vscode.postMessage({type:'entityDetails',index});status();buttons();dirty();
 }
 function inspected(data){
  if(data.index!==chosen||selected()?.revision!==data.revision)return;
  details=data;$('entityEditor').hidden=false;$('entitySnbt').value=data.text;panel.load(data);buttons();
 }
 function submit(action,more={}){
  if(blocked())return;
  const r=selected(),q={kind:'entity',action,index:r?.index,revision:r?.revision,...more};
  if(action!=='add'&&!r)return;
  if(action==='move'||action==='add'){
   const t=$('entityPos').value.trim().split(/[,，\s]+/);q.pos=t.map(Number);
   if(t.length!==3||t.some(v=>!v)||!q.pos.every(Number.isFinite)){notify('请输入有效的 X, Y, Z 坐标。',true);return;}
  }
  if(action==='add'){
   const id=$('entityId').value.trim();q.id=id.includes(':')?id:`minecraft:${id}`;
   if(!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(q.id)){notify('请输入有效的实体 ID，例如 minecraft:pig。',true);return;}
   if(!jar)return;
   if(catalog&&!catalog.types.includes(q.id)){notify('原版 /summon 不支持该实体类型。',true);return;}
  }
  edit(q);
 }
 $('entityList').onchange=()=>{choose($('entityList').value===''?null:+$('entityList').value);if(selected())onSelect();};
 $('entityCopy').onclick=()=>{if(selected()&&!blocked())vscode.postMessage({type:'copyEntity',index:chosen});};
 $('entityDelete').onclick=()=>submit('delete');
 $('entityMove').onclick=()=>submit('move');$('entityCreate').onclick=()=>submit('add');
 $('entityApplySnbt').onclick=()=>submit('nbt',{text:$('entitySnbt').value});
 $('entityPickPos').onclick=()=>setPicking(!picking);
 function setPicking(on,notify=true){if(on===picking)return;picking=on;status();buttons();if(notify)onPick(on);}
 $('renderEntities').checked=vscode.getState?.()?.renderEntities!==false;
 $('renderEntities').onchange=()=>{vscode.setState?.({...vscode.getState?.(),renderEntities:$('renderEntities').checked});onVisibilityChange(visible());dirty();};
 function plot(pos){if(!pos)return;$('entityPos').value=format(pos);setPicking(false);}
 function modelFor({id,baby,variant},skin){
  const models=catalog?.models,key=avatar(id)?(skin?.model==='slim'?id+'#slim':null):variant&&id+'#'+variant.replace(/^minecraft:/,'');
  return (key&&baby?models?.[key+'#baby']:null)??(key?models?.[key]:null)??(baby?models?.[id+'#baby']:null)??models?.[id];
 }
 function gpu(model){
  if(!meshes.has(model)){
   const vertices=new Float32Array(model.vertices),count=vertices.length/8;
   const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);meshes.set(model,{buffer,count});
  }return meshes.get(model);
 }
 function texture(name,skin,asset){
  if(!textures.has(name)){
   const state={tex:null};textures.set(name,state);
   const url=asset?`${root()}/${asset.replace(':','/textures/')}.png`:`${root()}/minecraft/textures/entity/${name}.png`;
   const pending=skin?skinImage(root(),skin):fetch(url).then(r=>{if(!r.ok)throw new Error();return r.blob();}).then(b=>createImageBitmap(b,{premultiplyAlpha:'none',colorSpaceConversion:'none'}));
   pending.then(img=>{
    const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);img.close();
    for(const p of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,p,gl.NEAREST);
    for(const p of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,p,gl.CLAMP_TO_EDGE);state.tex=t;dirty();
   }).catch(()=>{});
  }return textures.get(name).tex;
 }
 function visible(){return jar&&$('renderEntities').checked;}
 function draw(projection,vp,alpha,drawBox,available,clip=null,draft=null,group=null){
  if(!visible())return;
  const list=clip?.entities??rows;if(!list.length)return;
  if(clip){gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);gl.uniform1f(alpha,.5);}
  sampleEntityTexture(true);
  const boxes=[],translucent=[];
  const render=(model,tex,matrix)=>{const {buffer,count}=gpu(model);gl.bindTexture(gl.TEXTURE_2D,tex);gl.uniformMatrix4fv(vp,false,matrix);bind(buffer);gl.drawArrays(gl.TRIANGLES,0,count);};
  for(const e of list){
   const preview=!clip&&(draft?.index===e.index?draft:group?.get(e.index));
   let r=preview?{...e,...preview}:e;
   if(clip){const offset=axisTransform(clip.axes,e.pos.map(n=>n-.5));r={...e,pos:offset.map((n,i)=>n+clip.origin[i]+.5)};}
   if(!available(Math.floor(r.pos[1])))continue;
   let drawn=false;
   const hanging=r.hanging&&hangingModel(r);let basis;
   if(!r.invisible||r.hanging?.item){
    const color=r.id==='minecraft:cushion'&&r.variant?.replace(/^minecraft:/,''),palette=catalog?.cushionTextures;
    const skin=avatar(r.id)&&skins?.appearance(r.profile,catalog?.defaultSkins);
    const parts=r.hanging?hanging?.parts:modelFor(r,skin),cushion=color&&palette&&Object.hasOwn(palette,color)?palette[color]:null;
    let baseMatrix,itemMatrix;
    for(const part of parts??[]){
     const tex=part.asset?texture('asset:'+part.asset,null,part.asset):skin&&texture('skin:'+skin.key,skin)||texture(cushion||part.texture);
     if(!tex)continue;drawn=true;
     basis??=entityModelAxes(r,clip?.axes,preview?.rotation?preview.rotation[0]-e.rotation[0]:0);
     let matrix;
     if(part.item){
      const angle=r.hanging.spin*Math.PI/4,c=Math.cos(angle),s=Math.sin(angle);
      const itemAxes=[[c,s,0],[-s,c,0],[0,0,1]].map(axis=>axisTransform(basis,axis));
      const offset=(r.invisible?1/32:-1/32)-1e-4;
      itemMatrix??=projectMatrix(projection,r.pos.map((v,i)=>v+basis[2][i]*offset),itemAxes);matrix=itemMatrix;
     }else{baseMatrix??=projectMatrix(projection,r.pos,basis);matrix=baseMatrix;}
     if(!clip&&avatar(r.id)){
      // Solid skin texels need to occlude back faces even when the native batch also has translucent layers.
      skinPass(1);render(part,tex,matrix);skinPass(0);
      translucent.push({part,tex,matrix,player:true});
     }else if(part.translucent)translucent.push({part,tex,matrix});else render(part,tex,matrix);
    }
   }
   if(!r.invisible&&!drawn||!clip&&(chosen===r.index||group?.has(r.index)))boxes.push(entityBox(r,catalog?.sizes,hanging,basis));
  }
  if(translucent.length){
   if(!clip){gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);}
   translucent.sort((a,b)=>b.matrix[15]-a.matrix[15]);
   for(const {part,tex,matrix,player} of translucent){skinPass(player?2:0);render(part,tex,matrix);}
   skinPass(0);
   if(!clip){gl.depthMask(true);gl.disable(gl.BLEND);}
  }
  sampleEntityTexture(false);
  gl.uniformMatrix4fv(vp,false,projection);if(clip){gl.uniform1f(alpha,1);gl.depthMask(true);gl.disable(gl.BLEND);}
  for(const box of boxes)drawBox(box);
 }
 function hit(ray,available,limit=Infinity){
  if(!visible()||!ray)return null;let best=null,t=limit;
  for(const r of rows)if(available(Math.floor(r.pos[1]))){const box=entityBox(r,catalog?.sizes,hangingModel(r)),d=rayBox(ray,box.lo,box.hi);if(d<t){best=r;t=d;}}
  return best;
 }
 function transform(subject,draft){
  if(!draft||blocked()||selected()?.revision!==subject.revision||selected()?.index!==subject.index)return;
  if(draft.rotation&&subject.rotationMode&&subject.rotationMode!=='free')return;
  if(draft.pos?.every((v,i)=>v===subject.pos[i])||draft.rotation?.every((v,i)=>v===subject.rotation[i]))return;
  if(draft.pos)$('entityPos').value=format(draft.pos);
  edit({kind:'entity',action:draft.pos?'move':'rotate',index:subject.index,revision:subject.revision,...(draft.pos?{pos:draft.pos}:{yaw:draft.rotation[0]})});
 }
 return {setJar,setCatalog,setRows,buttons,choose,inspected,draw,hit,visible,plot,selected,transform,inRegion,matchGroup,types:()=>catalog?.types,picking:()=>picking,stopPick(notify){setPicking(false,notify);}};
}
