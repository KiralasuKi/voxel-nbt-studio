import {createStructureCommands} from './structure-command.js';
import {collisionIndex,traceCollision} from './collision-pick.js';
import {createEntities} from './entities.js';
import {createSceneRenderer,createChunkMeshes} from './scene-renderer.js';
import {playerSkins} from './player-skins.js';
import {clipPoint,clipSegment} from './box-projection.js';
import {createStateInspector,renderStateRows} from './inspect-form.js';
import {createNbtTree} from './nbt-tree.js';
import {blockId,createBlockPicker} from './block-picker.js';
import {Materials} from './materials.js';
import {Thumbnails} from './thumbnails.js';
import {hints,tagTypes} from './tile-schema.js';
import {schemaContext,nbtFields} from './mcdoc.js';
import {bindNbtCompletion} from './nbt-completion.js';
import {actions,defaults,keyFrom} from './shortcuts.js';
import {createMaskEditor} from './mask-editor.js';
import {maskAir,maskWorkLimit} from './mask.js';
import {identityAxes,blueprintPoint,blueprintMatrix,drawTemplateThumb,templateAnchor,anchorOrigin} from './blueprint.js';
const $=id=>document.getElementById(id);
let nbtCatalog=null,tileTypes={},collisions=null,collisionError=null;
const nbtSchema=dv=>nbtCatalog?schemaContext(nbtCatalog,dv??model?.dv,blockSchema):null;
const vscode=acquireVsCodeApi();
const canvas=$('scene');
const masks=createMaskEditor(vscode,{ids:blockChoices,preview:blockPreview});
const flightKeys=new Set(['KeyW','KeyA','KeyS','KeyD','Space','ShiftLeft','ShiftRight']);
const heldKeys=new Set();let flight=null,cursorAnchor=null,recenterAfterUnlock=false,cursorReturn=0;
const FLUID=new Set(['minecraft:water','minecraft:lava','minecraft:bubble_column']);
const STRUCTURE_VOID='minecraft:structure_void';
const AIR=new Set(['minecraft:air','minecraft:cave_air','minecraft:void_air',STRUCTURE_VOID]);
const names={view:'查看',place:'放置',paint:'涂刷',erase:'擦除',pick:'取样',extrude:'挤出选区',box:'框选区域'};
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
const plus=(a,b)=>a.map((v,i)=>v+b[i]); const minus=(a,b)=>a.map((v,i)=>v-b[i]); const times=(a,k)=>a.map(v=>v*k);
const dot=(a,b)=>a.reduce((v,n,i)=>v+n*b[i],0);const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>times(a,1/(Math.hypot(...a)||1));
const gl=canvas.getContext('webgl',{alpha:false,antialias:true});
let scene;
const meshes=createChunkMeshes(gl);
const bind=buffer=>scene.bind(buffer);
let headProfiles=new Map(),skinDefaults,headRun=0;
const skins=playerSkins(vscode,()=>{dirty();void refreshHeadSkins();if(blueprint?.blocks)void meshBlueprint();});
const entities=createEntities({vscode,skins,edit:q=>requestLayout(q),blocked:()=>!model||pending||fatal||Boolean(flight)||Boolean(blueprint),
 onPick:pickEntityPosition,onVisibilityChange:visible=>{if(!visible)boxEntities=[];selectionUI();},onSelect:()=>{if(!flight&&!blueprint&&!['view','pick'].includes(mode))setMode('view',true);},draftPosition:()=>model?[model.size[0]/2,layer,model.size[2]/2]:[0,0,0],notify:note,dirty,gl,bind,sampleEntityTexture:on=>gl.uniform1i(scene.uniforms.entityTexture,on?1:0),skinPass:pass=>gl.uniform1i(scene.uniforms.skinPass,pass),schema:nbtSchema,root:()=>document.body.dataset.assets});
let inspectorPending=null,snbtBase='',snbtRevision=null,snbtReading=false;
let thumbnails,thumbnailObserver,brushPicker,brushName='minecraft:stone',registryBlocks=[];let materials,matRun=0,textureOn=false,gameRender=false,renderGamma=.5,blockSchema={},prefs={},recording=null,altRemainder=0;
let showStructureBounds=false,showInvisible=false,markerMesh=null;
let selectionRegion=null,boxEntities=[],boxY=[0,0],moveRegion=null,sampleReturn=null,entityPickReturn=null,viewOverlay=null;
const overwriteIds=new Set((vscode.getState?.()?.overwriteIds??[]).filter(x=>typeof x==='string').slice(0,256));
const selection=new Set(),brushTools=new Set(['place','paint','erase']);
const BRUSH_PREVIEW=32767,TRANSFORM_AIR=(32768+1)*2;let brush=null,brushFrame=0;
let templates=[],blueprint=null,blueprintBuffer=null,blueprintRun=0,copyingTemplate=false;
$('templateShowInvisible').checked=Boolean(vscode.getState?.()?.templateShowInvisible);
$('pasteAnchor').value=vscode.getState?.()?.pasteAnchor==='corner'?'corner':'center';
let gizmo=[],rings=[],pivot=null,lastTurn=null,pickingPivot=false,tileHints=new Map();const transformMode=()=>mode==='box'||mode==='extrude';
let worker,model=null,cells=null,modelId=0,epoch=0,mode='view',layer=0,slice='full';
let camera,drag=null,hover=null,active=-1,inspectCell=null,busy=false,pending=false,fatal=false,frame=0,renderOver=false;
let commandCursor=null,lastClickPickedCoordinate=false;
let swatches=[]; const basic=new Map([
 ['grass_block',[.44,.65,.29]],['moss_block',[.40,.57,.24]],['dirt',[.55,.37,.24]],['water',[.24,.46,.85]],['lava',[1,.44,.09]],['oak_planks',[.71,.55,.34]],['smooth_quartz',[.91,.87,.83]],['stone',[.58,.58,.60]],['bricks',[.64,.34,.28]],['iron_block',[.79,.81,.84]],['gold_block',[.96,.76,.19]],['calcite',[.9,.86,.83]],['deepslate',[.27,.27,.31]]
]);
const dye={white:[.88,.89,.88],orange:[.92,.48,.16],magenta:[.71,.30,.67],light_blue:[.32,.65,.86],yellow:[.89,.74,.20],lime:[.46,.73,.16],pink:[.88,.51,.62],gray:[.33,.35,.37],light_gray:[.63,.63,.60],cyan:[.19,.55,.61],purple:[.48,.27,.66],blue:[.26,.33,.66],brown:[.46,.29,.18],green:[.31,.46,.18],red:[.64,.23,.19],black:[.18,.18,.22]};
let noteTimer=0;
function note(msg='',bad=false,sticky=fatal){
 if(fatal&&!bad)return;
 const el=$('message');
 if(noteTimer&&!sticky&&el.textContent===msg&&el.classList.contains('error')===bad)return;
 clearTimeout(noteTimer);noteTimer=0;
 el.textContent=msg;el.classList.toggle('error',bad);
 if(msg&&!sticky)noteTimer=setTimeout(()=>note(),4000);
}
const coord=(v)=>v?.join(', ')||'—';
const status=()=>{if(!model)return;$('stats').textContent=`${model.visible.toLocaleString()} 可见方块 · ${model.states.length} 种状态 · ${model.entities} 实体${model.dv===null?'':' · DV '+model.dv}${busy?' · 正在构建网格…':''}`;};
const rgba=(c)=>`rgb(${c.map(v=>Math.round(v*255)).join(',')})`;
let catalog={};
function color(s){const n=s.name.split(':').at(-1);if(catalog[n])return catalog[n].map(v=>v/255);if(basic.has(n))return basic.get(n);for(const k of Object.keys(dye).sort((a,b)=>b.length-a.length))if(n.startsWith(k+'_'))return dye[k];
 if(/quartz|snow|diorite/.test(n))return [.86,.85,.82];if(/wood|planks|_log|fence|barrel/.test(n))return [.53,.37,.24];if(/leaves|grass|fern|vine/.test(n))return [.38,.57,.25];if(/copper/.test(n))return n.includes('oxidized')?[.29,.62,.54]:[.72,.42,.29];if(/tuff|stone|slate/.test(n))return [.49,.50,.53];if(/glass/.test(n))return [.65,.76,.81];
 let h=2166136261;for(const ch of n)h=Math.imul(h^ch.charCodeAt(0),16777619);return [.43+(h&63)/260,.45+((h>>>6)&63)/270,.48+((h>>>12)&63)/260];
}
function unpack(base64){const s=atob(base64),b=new Uint8Array(s.length);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return new Uint32Array(b.buffer);}
function same(a,b){return a===b||a?.every((v,i)=>v===b?.[i]);}
function bounds(p){return p&&p.every((v,i)=>Number.isInteger(v)&&v>=0&&v<model.size[i]);}
function cell(p){const [w,,d]=model.size;return p[0]+w*(p[2]+d*p[1]);}
function value(p){return bounds(p)?cells[cell(p)]:0;}
function idAt(p){const n=(value(p)>>1)-1;return model.states[n]&&!AIR.has(model.states[n].name)?n:-1;}
function selectable(id){return id>=0&&($('selectFluid').checked||!FLUID.has(model.states[id].name));}
function selectableCell(p){if(!bounds(p))return false;const id=idAt(p);return id<0?showInvisible:selectable(id);}
function* activeSelection(){
 for(const c of selection)if(showInvisible||!AIR.has(model.states[(cells[c]>>1)-1]?.name)&&cells[c])yield c;
}
function selectedCount(){if(showInvisible)return selection.size;let n=0;for(const c of activeSelection())n++;return n;}
function availableLayer(y){return slice==='full'||(slice==='single'?y===layer:y<=layer);}
function pose(){
 const {yaw,pitch}=flight||camera,c=Math.cos(pitch);const back=[Math.sin(yaw)*c,Math.sin(pitch),Math.cos(yaw)*c];
 const eye=flight?.eye??plus(camera.target,times(back,camera.distance)),right=unit(cross([0,1,0],back)),up=unit(cross(back,right));return {eye,back,right,up};
}
const fov=95*Math.PI/180, mouseSensitivityScale=.85;
function matrix(aspect){
 const {eye,back,right,up}=pose(),f=1/Math.tan(fov/2),near=.055,far=Math.max(4096,Math.hypot(...eye)+Math.hypot(...model.size)*4),a=(far+near)/(near-far),b=2*far*near/(near-far);
 return new Float32Array([right[0]*f/aspect,up[0]*f,back[0]*a,-back[0],right[1]*f/aspect,up[1]*f,back[1]*a,-back[1],right[2]*f/aspect,up[2]*f,back[2]*a,-back[2],-dot(right,eye)*f/aspect,-dot(up,eye)*f,-dot(back,eye)*a+b,dot(back,eye)]);
}
function dirty(){if(!frame)frame=requestAnimationFrame(draw);}
// Outline the 12 edges of the voxel bounds in WebGL. Expand them into screen-space
// strips because some GPUs only support one-pixel GL_LINES, even on high-DPI displays.
const axisColors=[[.95,.33,.31],[.42,.86,.43],[.33,.57,1]];
const screenProjection=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
function screenStroke(out,ax,ay,bx,by,width,height,r,color,az=0,bz=0){
 const len=Math.hypot(bx-ax,by-ay);if(len<.01)return;
 const dx=(bx-ax)/len,dy=(by-ay)/len;
 const at=(x,y,z,t,n)=>[2*(x+dx*t*r-dy*n*r)/width,2*(y+dy*t*r+dx*n*r)/height,z,...color,-1,-1];
 const p=at(ax,ay,az,-1,1),q=at(ax,ay,az,-1,-1),r0=at(bx,by,bz,1,-1),s=at(bx,by,bz,1,1);
 out.push(...p,...q,...r0,...p,...r0,...s);
}
function drawScreenStrokes(halo,frame,projection){
 if(!frame.length)return;
 const data=new Float32Array(halo.length+frame.length);data.set(halo);data.set(frame,halo.length);
 bind(scene.lines);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STREAM_DRAW);
 gl.uniformMatrix4fv(scene.uniforms.vp,false,screenProjection);gl.drawArrays(gl.TRIANGLES,0,data.length/8);gl.uniformMatrix4fv(scene.uniforms.vp,false,projection);
}
function drawSelection(region,projection,kind='selection'){
 const lo=region.lo,hi=kind==='entity'?region.hi:region.hi.map(v=>v+1),{eye}=pose(),outer=kind==='bounds';
 const width=canvas.clientWidth,height=canvas.clientHeight;
 const vertices=Array.from({length:8},(_,bits)=>clipPoint(projection,lo.map((n,i)=>bits&(1<<i)?hi[i]:n)));
 const front=lo.map((n,i)=>[eye[i]<n,eye[i]>hi[i]]),inside=front.every(pair=>!pair[0]&&!pair[1]);
 const halo=[],frame=[];
 for(let axis=0;axis<3;axis++)for(let bits=0;bits<8;bits++)if(!(bits&(1<<axis))){
  const edge=clipSegment(vertices[bits],vertices[bits|(1<<axis)]);if(!edge)continue;
  const [a,b]=edge,u=(axis+1)%3,v=(axis+2)%3,visible=inside||front[u][(bits>>u)&1]||front[v][(bits>>v)&1];
  const stroke=(out,r,color)=>screenStroke(out,a[0]*width/2,a[1]*height/2,b[0]*width/2,b[1]*height/2,width,height,r,color,a[2],b[2]);
  if(outer)stroke(frame,visible?.65:.48,bits===0?axisColors[axis]:[.98,.98,.98]);
  else if(kind==='hover')stroke(frame,.75,[.40,.85,1]);
  else if(kind==='entity')stroke(frame,.9,[.97,.67,.28]);
  else if(kind==='commandPick'){
   stroke(halo,visible?2.8:1.65,[.025,.11,.055]);
   stroke(frame,visible?1.5:.85,visible?[.27,1,.39]:[.16,.68,.29]);
  }
  else{
   stroke(halo,visible?2.5:1.6,[.025,.085,.105]);
   stroke(frame,visible?1.25:.65,visible?[.36,.96,1]:[.17,.56,.68]);
  }
 }
 // Keep coplanar edges visible without drawing through foreground blocks.
 gl.depthMask(false);gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(-.5,-2);
 drawScreenStrokes(halo,frame,projection);
 gl.disable(gl.POLYGON_OFFSET_FILL);gl.depthMask(true);
}
function drawStructureBounds(projection){
 if(!showStructureBounds)return;
 gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.uniform1f(scene.uniforms.opacity,.5);
 drawSelection({lo:[0,0,0],hi:model.size.map(n=>n-1)},projection,'bounds');
 gl.uniform1f(scene.uniforms.opacity,1);gl.disable(gl.BLEND);
}
function clearMarkers(){if(markerMesh){gl.deleteBuffer(markerMesh.buffer);markerMesh=null;}}
function drawMarkers(){
 if(!showInvisible||!markerMesh)return;
 gl.depthMask(false);bind(markerMesh.buffer);gl.drawArrays(gl.LINES,0,markerMesh.count);gl.depthMask(true);
}
function draw(now){
 frame=0;if(!scene)return;
 if(flight)stepFlight(now);
 const dpr=Math.min(window.devicePixelRatio||1,2),w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr));
 if(w!==canvas.width||h!==canvas.height){canvas.width=w;canvas.height=h;}
 gl.viewport(0,0,w,h);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);if(!camera)return;
 const projection=matrix(w/h);gl.uniformMatrix4fv(scene.uniforms.vp,false,projection);gl.uniform1f(scene.uniforms.sceneGamma,gameRender?renderGamma:0);
 if(materials)gl.bindTexture(gl.TEXTURE_2D,materials.texture);
 const alpha=[];for(const mesh of meshes.values()){if(mesh.alpha)alpha.push(mesh);else {bind(mesh.buffer);gl.drawArrays(gl.TRIANGLES,0,mesh.len);}}
 const takingCoordinates=Boolean(commandBar.picking());
 const subject=takingCoordinates?null:entityGizmo(),draft=subject&&drag?.subject===subject?entityTransformDraft(drag):null;
 entities.draw(projection,scene.uniforms.vp,scene.uniforms.opacity,b=>drawSelection(b,projection,'entity'),availableLayer,null,draft&&{...draft,index:subject.index},mode==='box'&&!blueprint?boxEntityPreview():null);
 if(materials)gl.bindTexture(gl.TEXTURE_2D,materials.texture);
 if(alpha.length){const {eye,back}=pose();alpha.sort((a,b)=>dot(minus(a.center,b.center),back));gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);for(const m of alpha){bind(m.buffer);gl.drawArrays(gl.TRIANGLES,0,m.len);}gl.depthMask(true);gl.disable(gl.BLEND);}
 gl.uniform1f(scene.uniforms.sceneGamma,0);drawMarkers();
 if(flight){
  if(blueprint?.origin&&blueprintBuffer)drawBlueprint(projection);
  drawStructureBounds(projection);if(flight.region)drawSelection(flight.region,projection);
  return;
 }
 const [x,,z]=model.size,grid=[],axisHalo=[],axisFrame=[];let box=null;
 const line=(to,a,b,c)=>to.push(...a,...c,-1,-1,...b,...c,-1,-1);
 const k=Math.max(1,Math.ceil(Math.max(x,z)/60)),gy=layer-.012;
 for(let i=0;i<=x;i+=k)line(grid,[i,gy,0],[i,gy,z],i===0?[.39,.45,.58]:[.22,.28,.37]);
 for(let i=0;i<=z;i+=k)line(grid,[0,gy,i],[x,gy,i],i===0?[.39,.45,.58]:[.22,.28,.37]);

 box=takingCoordinates?null:overlayRegion();
 gizmo=[];rings=[];
 if(!takingCoordinates&&(transformMode()||subject)){
  const sel=subject?{center:plus(draft?.pos??subject.pos,[0,.55,0])}:mode==='box'&&boxDraft()?null:selectionBounds();
  if(sel){const {lo,hi,center}=sel;const move=drag?.nav==='gizmo'?drag.steps:0,axis=drag?.axis;
   const ofs=[0,0,0];if(move)ofs[axis]=move;
   if(!subject){
    const a=mode==='extrude'?lo.map((v,i)=>Math.min(v,v+ofs[i])):plus(lo,ofs),b=mode==='extrude'?hi.map((v,i)=>Math.max(v,v+ofs[i])):plus(hi,ofs);
    if(selectionRegion){const a=plus(selectionRegion.lo,ofs),b=plus(selectionRegion.hi,ofs);
     box=regionOf(mode==='extrude'?a.map((v,i)=>Math.min(v,selectionRegion.lo[i])):a,mode==='extrude'?b.map((v,i)=>Math.max(v,selectionRegion.hi[i])):b);}
    else box=regionOf(a,b);
    if(drag?.nav==='rotate'&&drag.steps)box=regionOf(turnCell(box.lo,drag),turnCell(box.hi,drag));
   }
   const span=subject?clamp(Math.hypot(...minus(pose().eye,center))*.14,.55,35):clamp(camera.distance*.10,2.3,250);
   const o=mode==='box'?plus(center,ofs):center;
   const rect=canvas.getBoundingClientRect(),view=pose();
   const stroke=(a,b,c)=>{
    let u=project(a,rect,view),v=project(b,rect,view);if(!u&&!v)return;
    if(!u||!v){const da=dot(minus(view.eye,a),view.back),db=dot(minus(view.eye,b),view.back);
     const clipped=project(plus(a,times(minus(b,a),(Math.min(.06,Math.max(da,db))-da)/(db-da))),rect,view);
     if(!u)u=clipped;else v=clipped;if(!u||!v)return;
    }
    const x=rect.left+rect.width*.5,y=rect.top+rect.height*.5;
    screenStroke(axisHalo,u[0]-x,y-u[1],v[0]-x,y-v[1],rect.width,rect.height,2.5,[.07,.09,.13]);
    screenStroke(axisFrame,u[0]-x,y-u[1],v[0]-x,y-v[1],rect.width,rect.height,1.5,c);
   };
   for(let a=0;a<3;a++)for(const sign of [-1,1]){const end=o.slice();end[a]+=span*sign;const base=end.slice();base[a]-=span*.15*sign;stroke(o,end,axisColors[a]);
    for(let z=1;z<=2;z++){const c=(a+z)%3;for(const d of [-1,1]){const wing=base.slice();wing[c]+=d*span*.075;stroke(wing,end,axisColors[a]);}}
    const pt=project(end,rect,view),mid=project(plus(o,times(minus(end,o),.42)),rect,view),step=project(plus(end,[a===0?1:0,a===1?1:0,a===2?1:0]),rect,view);
    if(pt&&mid&&step)gizmo.push({axis:a,subject,pt,mid,slope:[step[0]-pt[0],step[1]-pt[1]]});
   }
   if((subject?(!subject.rotationMode||subject.rotationMode==='free'):mode==='box'&&!move)&&drag?.nav!=='entityMove'){
    const [cx,cy]=[rect.left+rect.width*.5,rect.top+rect.height*.5],w=rect.width,h=rect.height;
    const segment=(a,b,r,c)=>screenStroke(axisFrame,a[0]-cx,cy-a[1],b[0]-cx,cy-b[1],w,h,r,c);
    const ball=(pt,r,c)=>{const vertex=(x,y)=>[2*(x-cx)/w,2*(cy-y)/h,0,...c,-1,-1];const center=vertex(...pt);
     for(let i=0;i<12;i++){const at=j=>vertex(pt[0]+r*Math.cos(j*Math.PI/6),pt[1]+r*Math.sin(j*Math.PI/6));axisFrame.push(...center,...at(i),...at(i+1));}};
    const handles=[],yawOnly=subject||selectionYawOnly();
    for(let a=0;a<3;a++){
     if(yawOnly&&a!==1||['rotate','entityRotate'].includes(drag?.nav)&&drag.axis!==a)continue;
     const p=subject?center:rotationPivot(a,center),r=span*(subject?1.4:1.23),points=[],c=axisColors[a];
     const vector=angle=>ringVector(a,angle);
     for(let i=0;i<=48;i++)points.push(project(plus(p,times(vector(i*Math.PI/24),r)),rect,view));
     for(let i=0;i<48;i++)if(points[i]&&points[i+1]){
      segment(points[i],points[i+1],drag?.nav==='rotate'?1.8:1.15,c);
      rings.push({axis:a,subject,pivot:p,from:points[i],to:points[i+1]});
      if(i%12===3&&dot(minus(view.eye,p),vector(i*Math.PI/24))>=0)handles.push([points[i],c]);
     }
    }
    for(const [pt,c] of handles){ball(pt,5.6,[.07,.09,.13]);ball(pt,4.6,c);ball([pt[0]-1.2,pt[1]-1.4],1.8,c.map(v=>v+(1-v)*.63));}
    if(pivot&&!subject){const pt=project(pivot,rect,view);if(pt){ball(pt,4.2,[.07,.09,.13]);ball(pt,2.8,[1,.81,.38]);}}
   }
  }else if(!box&&selectionRegion)box=selectionRegion;
 }
 const render=points=>{bind(scene.lines);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(points),gl.STREAM_DRAW);gl.drawArrays(gl.LINES,0,points.length/8);};
 if(grid.length)render(grid);if(blueprint?.origin&&blueprintBuffer)drawBlueprint(projection);
 drawStructureBounds(projection);
 if(takingCoordinates){
  const p=commandCursor&&commandPointAt(commandCursor);
  $('coords').textContent=p?coord(p):'—';
  if(p)drawSelection({lo:p,hi:p},projection,'commandPick');
 }else if(box)drawSelection(box,projection);else if(hover&&mode!=='view')drawSelection({lo:hover,hi:hover},projection,'hover');
 if(axisFrame.length){gl.disable(gl.DEPTH_TEST);drawScreenStrokes(axisHalo,axisFrame,projection);gl.enable(gl.DEPTH_TEST);}
}
function reset(top=false){if(!model)return;setFlight(false,true);const [w,h,d]=model.size;camera={target:[w/2,h*.48,d/2],yaw:top?0:.70,pitch:top?1.565:.47,distance:Math.max(4,Math.hypot(w,h,d)*1.07)};dirty();}
function clearFlightKeys(){heldKeys.clear();if(flight){flight.last=null;flight.aim=null;}}
function updateFlightHelp(){
 const look=document.pointerLockElement===canvas?'鼠标转向':'画布内移动鼠标转向';
 $('flightHelp').textContent=`WASD 移动 · ${look} · 空格上升 / Shift 下降 · 滚轮调速 · 只读预览 · Esc 退出`;
}
function lockFlightPointer(){
 if(!canvas.requestPointerLock||document.pointerLockElement===canvas)return;
 try{canvas.requestPointerLock()?.catch(()=>updateFlightHelp());}catch{updateFlightHelp();}
}
function lookFlight(dx,dy){
 if(!dx&&!dy)return;
 const sensitivity=.0028*mouseSensitivityScale;
 flight.yaw-=dx*sensitivity;flight.pitch=clamp(flight.pitch+dy*sensitivity,-1.565,1.565);dirty();
}

function rememberCursor(e){
 if(e.isTrusted&&document.pointerLockElement!==canvas)cursorAnchor={x:e.clientX,y:e.clientY,w:innerWidth,h:innerHeight,scale:devicePixelRatio};
}
function centerFlightCursor(){
 const request=++cursorReturn;
 requestAnimationFrame(()=>{
  const a=cursorAnchor;if(request!==cursorReturn||flight||document.pointerLockElement||!document.hasFocus()||document.hidden||!a||a.w!==innerWidth||a.h!==innerHeight||a.scale!==devicePixelRatio)return;
  const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;
  // The native pointer is restored by Chromium before pointerlockchange. Map the CSS delta to physical pixels.
  const dx=Math.round((r.left+r.width/2-a.x)*a.scale),dy=Math.round((r.top+r.height/2-a.y)*a.scale);
  if(dx||dy)vscode.postMessage({type:'centerCursor',dx,dy});
 });
}
function setFlight(on,recenter=false){
 if(on===Boolean(flight)||on&&(!camera||fatal||pending||brush||drag))return;
 clearFlightKeys();
 if(on){
  cursorReturn++;recenterAfterUnlock=false;
  flight={eye:pose().eye.slice(),yaw:camera.yaw,pitch:camera.pitch,speed:16,last:null,locked:false,aim:null,region:overlayRegion()};
  hover=null;canvas.focus();updateFlightHelp();lockFlightPointer();
 }else{
  const {eye,back}=pose(),{yaw,pitch}=flight;
  // Put the orbit pivot on the current sight line so switching modes does not move the eye.
  const distance=Math.max(.65,dot(minus(eye,camera.target),back));
  camera={yaw,pitch,distance,target:minus(eye,times(back,distance))};flight=null;
  if(document.pointerLockElement===canvas){recenterAfterUnlock=recenter;document.exitPointerLock();}
  else if(recenter)centerFlightCursor();
 }
 $('tools').inert=document.querySelector('.sidebar').inert=on;
 $('keyboard').disabled=on;updateDraft();
 $('flyView').setAttribute('aria-pressed',String(on));$('flightHelp').hidden=$('flightReticle').hidden=!on;
 $('mode').textContent=on?'第一人称':names[mode];$('coords').textContent='—';$('coords').classList.toggle('flight-coords',on);dirty();
}
function stepFlight(now){
 const f=flight,dt=f.last===null?0:clamp((now-f.last)/1000,0,.05),key=k=>Number(heldKeys.has(k));
 if(heldKeys.size&&!fatal){
  f.last=now;
  const ahead=key('KeyW')-key('KeyS'),side=key('KeyD')-key('KeyA'),rise=key('Space')-Number(heldKeys.has('ShiftLeft')||heldKeys.has('ShiftRight'));
  if(ahead||side||rise){
   const sin=Math.sin(f.yaw),cos=Math.cos(f.yaw),step=f.speed*dt/Math.hypot(ahead,side,rise);
   f.eye=plus(f.eye,times([-sin*ahead+cos*side,rise,-cos*ahead-sin*side],step));
  }
  dirty();
 }else f.last=null;
 const text=`位置 ${f.eye.map(n=>n.toFixed(1)).join(', ')} · ${f.speed.toFixed(1)} 格/秒`;
 if($('coords').textContent!==text)$('coords').textContent=text;
}
function positionOf(cell){const [w,,l]=model.size,q=Math.floor(cell/w);return [cell%w,Math.floor(q/l),q%l];}
function templateButtons(){
 $('copyTemplate').disabled=Boolean(commandBar.picking())||!model||!selection.size&&!selectionRegion||pending||Boolean(blueprint)||copyingTemplate;
 $('templatePlacement').hidden=!blueprint;
 $('placeTemplateEntities').disabled=Boolean(pending||flight);
 const locked=fatal||!model||pending||Boolean(brush)||Boolean(flight),viewing=Boolean(blueprint&&mode==='view');
 $('undo').disabled=locked||viewing||Boolean(blueprint&&!blueprint.past.length);
 $('redo').disabled=locked||viewing||Boolean(blueprint&&!blueprint.future.length);
 $('confirmPaste').disabled=locked||viewing||!blueprint?.origin||!blueprintBuffer||!blueprint.visibleCount;
 $('ignorePasteFluids').disabled=pending||viewing;$('pasteAnchor').disabled=pending||viewing;
 $('cancelPaste').disabled=pending;
 $('templateHelp').textContent=!blueprint?'点列表里的模板，再到画布上选择落点。':viewing?'蓝图已保留；切回框选可继续调整。':!blueprint.origin?'点击一个方块的外侧或当前层空位，确定蓝图放置点。':blueprint.visibleCount===0?'忽略流体后没有可放置的方块。':selectionYawOnly()?'蓝图含实体，仅可绕 Y 轴旋转。Enter 放置，Esc 取消。':'拖坐标轴移动、拖旋转环调整；Enter 放置，Esc 取消。';
}
const includeClipEntities=item=>item.entityOnly||$('placeTemplateEntities').checked;
$('placeTemplateEntities').checked=vscode.getState?.()?.placeTemplateEntities!==false;
const templateImages=new Map(),templateRenders=new Map();
async function previewMaterials(states){
 const styles=await Promise.all(states.map(s=>materials.state(s)));
 const fluidUV=states.some(s=>FLUID.has(s.name)||s.props?.waterlogged==='true'||/^minecraft:(kelp|kelp_plant|seagrass|tall_seagrass)$/.test(s.name))?materials.fluidUV():{};
 await materials.idle();return {styles,fluidUV};
}
function textureTemplateThumb(canvas,item){
 if(!textureOn||!materials||!thumbnails?.ok)return;
 if(!item.thumb.length)return;
 const id=`${item.id}:${Number($('templateShowInvisible').checked)}`;
 if(!templateImages.has(id)){
  const {states,thumb:blocks,size}=item;
  const image=previewMaterials(states).then(fields=>{
   if(!templateImages.has(id))return null;
   return new Promise(done=>{
    templateRenders.set(id,done);worker.postMessage({type:'templateThumb',id,states,blocks,size,colors:states.map(color),...fields});
   });
  }).catch(()=>null);
  templateImages.set(id,image);
 }
 templateImages.get(id).then(image=>{
  if(!image||!textureOn||!canvas.isConnected)return;
  canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').putImageData(image,0,0);
 });
}
function renderTemplateList(){
 const list=$('templateList');list.replaceChildren();
 for(const item of templates){
  const row=document.createElement('div'),pick=document.createElement('button'),thumb=document.createElement('canvas'),label=document.createElement('span'),desc=document.createElement('small'),drop=document.createElement('button'),save=document.createElement('button'),actions=document.createElement('div');
  row.className='template-row';pick.className='template-pick';pick.dataset.template=item.id;pick.setAttribute('aria-pressed',String(blueprint?.item.id===item.id));
  thumb.width=thumb.height=64;thumb.setAttribute('aria-hidden','true');const preview=$('templateShowInvisible').checked?{...item,thumb:[...item.thumb,...(item.invisibleThumb??[])]}:item;drawTemplateThumb(thumb,preview,color);
  label.textContent=item.name;desc.textContent=`${item.size.join(' × ')} · ${item.count} 格${item.entityCount?` · ${item.entityCount} 实体`:''}`;label.append(desc);pick.append(thumb,label);
  pick.onclick=()=>startBlueprint(item);drop.textContent='移除';drop.setAttribute('aria-label','移除 '+item.name);drop.onclick=()=>vscode.postMessage({type:'dropTemplate',id:item.id});save.textContent='保存…';save.setAttribute('aria-label','保存 '+item.name+' 为 NBT');save.onclick=()=>vscode.postMessage({type:'saveTemplate',id:item.id});
  actions.className='template-actions';actions.append(save,drop);row.append(pick,actions);list.append(row);textureTemplateThumb(thumb,preview);
 }
}
function copyTemplate(){
 if(!model||pending||blueprint||copyingTemplate||drag||brush||fatal||commandBar.picking())return;
 if(mode==='box'&&boxDraft()){note('请先选定范围，再复制临时模板。',true);return;}
 const selected=[...selection].filter(c=>cells[c]);if(!selected.length&&!selectionRegion&&!boxEntities.length)return;
 copyingTemplate=true;templateButtons();vscode.postMessage({type:'copyTemplate',selection:selected,region:selectionRegion??selectionBounds(),includeInvisible:true,entitySelection:entitySelection()});
}
$('templateShowInvisible').onchange=()=>{vscode.setState?.({...vscode.getState?.(),templateShowInvisible:$('templateShowInvisible').checked});renderTemplateList();};
$('pasteAnchor').onchange=()=>{
 const next=$('pasteAnchor').value;vscode.setState?.({...vscode.getState?.(),pasteAnchor:next});
 if(!blueprint)return;
 const {item,axes,anchor}=blueprint;
 if(blueprint.origin&&next!==anchor){blueprint.past.push(blueprintSnapshot());blueprint.future.length=0;const point=blueprintPoint(templateAnchor(item.size,anchor),blueprint);blueprint.origin=anchorOrigin(point,templateAnchor(item.size,next),axes);}
 blueprint.anchor=next;selectionUI();dirty();
};
function clearBlueprint(){
 if(!blueprint)return;blueprintRun++;blueprint=null;if(mode==='view')viewOverlay=null;pivot=lastTurn=null;pickingPivot=false;if(blueprintBuffer){gl.deleteBuffer(blueprintBuffer.buffer);blueprintBuffer=null;}
 renderTemplateList();templateButtons();dirty();
}
function startBlueprint(item){
 if(!model||pending||drag||brush||fatal)return;clearBlueprint();sampleReturn=null;
 selection.clear();selectionRegion=null;boxEntities=[];setCorners(null);pivot=lastTurn=null;pickingPivot=false;
 blueprint={item,origin:null,axes:identityAxes(),anchor:$('pasteAnchor').value,past:[],future:[]};setMode('box');$('transformPanel').open=true;showSidebar('templates');selectionUI();renderTemplateList();canvas.focus();dirty();
}
function blueprintPose(d){
 const {origin,axes}=blueprint;if(!d?.steps)return {origin,axes};
 if(d.nav==='gizmo')return {origin:origin.map((n,i)=>n+(i===d.axis?d.steps:0)),axes};
 if(d.nav==='rotate'){const p=turnCell(origin,d);return {origin:p,axes:axes.map(a=>minus(turnCell(plus(origin,a),d),p))};}
 return {origin,axes};
}
async function meshBlueprint(refresh=false){
 if(!blueprint?.blocks)return;
 const run=++blueprintRun,{item,states,colors}=blueprint,textured=textureOn&&materials;
 const blocks=$('ignorePasteFluids').checked?blueprint.blocks.filter(b=>!FLUID.has(states[b[3]].name)):blueprint.blocks;
 blueprint.visibleCount=blocks.length+(includeClipEntities(item)?blueprint.entities?.length??0:0);selectionUI();
 const send=(styles,fluidUV,headSkins)=>worker.postMessage({type:'blueprintMesh',model:modelId,run,size:item.size,states,blocks,colors,styles,fluidUV,headSkins,game:gameRender});
 if(!blueprintBuffer||!textured||refresh)send([],{});
 if(textured&&blocks.length){
  const [{styles,fluidUV},headSkins]=await Promise.all([previewMaterials(states),headSkinUVs(blueprint.headProfiles)]);if(run===blueprintRun)send(styles,fluidUV,headSkins);
 }
}
function drawBlueprint(projection){
 bind(blueprintBuffer.buffer);gl.uniform1f(scene.uniforms.opacity,.5);gl.uniform1f(scene.uniforms.sceneGamma,gameRender?renderGamma:0);gl.uniformMatrix4fv(scene.uniforms.vp,false,blueprintMatrix(projection,blueprintPose(drag)));
 // A depth-only pass makes the nearest blueprint surface blend once at 50%, even on hollow models.
 gl.colorMask(false,false,false,false);gl.drawArrays(gl.TRIANGLES,0,blueprintBuffer.count);gl.colorMask(true,true,true,true);
 gl.depthFunc(gl.EQUAL);gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.drawArrays(gl.TRIANGLES,0,blueprintBuffer.count);
 gl.disable(gl.BLEND);gl.depthMask(true);gl.depthFunc(gl.LESS);gl.uniform1f(scene.uniforms.opacity,1);gl.uniform1f(scene.uniforms.sceneGamma,0);gl.uniformMatrix4fv(scene.uniforms.vp,false,projection);
 if(includeClipEntities(blueprint.item))entities.draw(projection,scene.uniforms.vp,scene.uniforms.opacity,b=>drawSelection(b,projection,'entity'),availableLayer,{...blueprintPose(drag),entities:blueprint.entities});
 if(materials)gl.bindTexture(gl.TEXTURE_2D,materials.texture);
}
function overwriteSettings(){return {moveOverwrite:$('moveOverwrite').checked,overwriteIds:[...overwriteIds],allowNbt:$('overwrite').checked};}
function commitBlueprint(){
 if(!blueprint?.origin||!blueprintBuffer||!blueprint.visibleCount||pending||drag||fatal||sampleReturn||flight||mode!=='box')return;
 pending=true;updateDraft();note('');vscode.postMessage({type:'edit',edit:{tool:'paste',template:blueprint.item.id,origin:blueprint.origin,axes:blueprint.axes,ignoreFluids:$('ignorePasteFluids').checked,placeEntities:includeClipEntities(blueprint.item),...overwriteSettings()}});
}
function blueprintSnapshot(){return {origin:blueprint.origin,axes:blueprint.axes,anchor:blueprint.anchor,pivot:lastTurn};}
function undoEdit(redo){
 if(flight)return;
 if(!blueprint){vscode.postMessage({type:redo?'redo':'undo'});return;}
 if(pending||drag||mode==='view')return;
 const from=redo?blueprint.future:blueprint.past,to=redo?blueprint.past:blueprint.future;
 if(!from.length)return;
 to.push(blueprintSnapshot());const {origin,axes,anchor,pivot:previousTurn}=from.pop();
 Object.assign(blueprint,{origin,axes,anchor});$('pasteAnchor').value=anchor;lastTurn=previousTurn;selectionUI();canvas.focus();dirty();
}
function selectionBounds(){
 if(blueprint?.origin){const r=regionOf(blueprint.origin,blueprintPoint(blueprint.item.size.map(n=>n-1),blueprint));return {...r,center:r.lo.map((v,i)=>(v+r.hi[i]+1)/2)};}
 if(!model)return null;const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];let any=false;
 const include=p=>{any=true;for(let i=0;i<3;i++){lo[i]=Math.min(lo[i],p[i]);hi[i]=Math.max(hi[i],p[i]);}};
 for(const n of activeSelection())include(positionOf(n));
 for(const row of boxEntities)include(row.pos.map(Math.floor));
 return any?{lo,hi,center:lo.map((v,i)=>(v+hi[i]+1)/2)}:null;
}
function project(p,r,{eye,right,up,back}){const v=minus(p,eye),d=-dot(v,back);if(d<=.05)return null;const s=r.height*.5/(Math.tan(fov/2)*d);return [r.left+r.width*.5+dot(v,right)*s,r.top+r.height*.5-dot(v,up)*s];}
function ringVector(axis,angle){const v=[0,0,0];v[(axis+1)%3]=Math.cos(angle);v[(axis+2)%3]=Math.sin(angle);return v;}
function rotationPivot(axis,center){
 if(pivot)return pivot;
 if(lastTurn?.axis===axis)return lastTurn.pivot;
 const p=selectionRegion?selectionRegion.lo.map((v,i)=>(v+selectionRegion.hi[i]+1)/2):center.slice(),a=(axis+1)%3,b=(axis+2)%3;
 if((2*p[a])%2!==(2*p[b])%2)p[b]-=.5;
 return p;
}
function turnCell(pos,{axis,pivot,steps}){
 const a=(axis+1)%3,b=(axis+2)%3,p=pos.map((v,i)=>v+.5-pivot[i]);
 for(let i=0;i<(steps%4+4)%4;i++){const n=p[a];p[a]=-p[b];p[b]=n;}
 return p.map((v,i)=>v+pivot[i]-.5);
}
function tryGizmo(ev,subject=null){
 if(!subject&&pickingPivot||ev.ctrlKey||ev.metaKey)return null;
 let best=null,dist=15;const mouse=[ev.clientX,ev.clientY];
 for(const h of gizmo){if(h.subject!==subject)continue;const line=minus(h.pt,h.mid),v=minus(mouse,h.mid),t=clamp(dot(v,line)/(dot(line,line)||1),0,1);
  const d=Math.hypot(...minus(v,times(line,t)));if(d<dist&&dot(h.slope,h.slope)>.15){dist=d;best=h;}}
 if(dist<3)return best;
 let ring=null,radius=Math.min(8,dist);const yawOnly=!!subject||selectionYawOnly();
 for(const r of rings){if(r.subject!==subject)continue;const v=minus(r.to,r.from),w=minus(mouse,r.from),length=Math.hypot(...v);if(length<.12)continue;
  const t=clamp(dot(w,v)/(length*length),0,1),d=Math.hypot(...minus(w,times(v,t)));
  if(d<radius&&(!yawOnly||r.axis===1)){radius=d;ring={...r,tangent:times(v,1/length)};}}
 return ring||best;
}
function ringAngle(ev,{axis,pivot}){
 const {eye,d}=ray(ev);if(Math.abs(d[axis])<.08)return null;
 const t=(pivot[axis]-eye[axis])/d[axis];if(t<=0)return null;
 const v=minus(plus(eye,times(d,t)),pivot),a=(axis+1)%3,b=(axis+2)%3;
 return Math.hypot(v[a],v[b])>.1?Math.atan2(v[b],v[a]):null;
}
function entityGizmo(){
 if(pending||flight||blueprint||entities.picking()||$('pane-entities').hidden||!['view','pick'].includes(mode))return null;
 const row=entities.selected();return row&&availableLayer(Math.floor(row.pos[1]))?row:null;
}
function entityTransformDraft(d){
 if(d.nav==='entityMove'){
  const pos=d.subject.pos.slice(),a=d.axis;
  pos[a]=clamp(pos[a]+d.steps,0,model.size[a]-1e-5);return {pos};
 }
 const [yaw,pitch]=d.subject.rotation;
 return {rotation:[((yaw-d.steps+180)%360+360)%360-180,pitch]};
}
function rotateDrag(ev,d,dx,dy){
 const next=ringAngle(ev,d);
 if(d.last!==null&&next!==null)d.total+=Math.atan2(Math.sin(next-d.last),Math.cos(next-d.last));
 else d.total+=(dx*d.tangent[0]+dy*d.tangent[1])*.027;
 d.last=next;
}
let transformFrame=0,transformPreview=false;
function clearTransformPreview(){
 if(transformFrame){cancelAnimationFrame(transformFrame);transformFrame=0;}
 if(transformPreview){transformPreview=false;worker.postMessage({type:'brushClear',model:modelId});}
}
function queueTransformPreview(d){
 if(blueprint||d.nav==='gizmo'&&mode!=='box'||transformFrame)return;
 transformFrame=requestAnimationFrame(()=>{transformFrame=0;if(drag===d)previewBlockTransform(d);});
}
function previewBlockTransform(d){
 const turn=d.nav==='rotate',steps=turn?d.steps%4:d.steps;
 if(!steps){clearTransformPreview();return;}
 const picked=d.cells??=new Set(activeSelection()),source=[],dest=[],headSources=[];
 const {moveOverwrite,allowNbt}=overwriteSettings(),allowMoveTile=$('moveTile').checked;
 for(const c of picked){
  const v=cells[c];if(!v)continue;
  const p=positionOf(c),to=turn?turnCell(p,d):p;
  if(!turn)to[d.axis]+=steps;
  if(!bounds(to)||v&1&&!allowMoveTile){clearTransformPreview();return;}
  const at=cell(to),existing=cells[at],name=model.states[(existing>>1)-1]?.name;
  if(!picked.has(at)&&((existing&1)||(name&&!AIR.has(name)))&&
    (!moveOverwrite||existing&1&&!allowNbt||overwriteIds.size&&name&&!AIR.has(name)&&!overwriteIds.has(name))){clearTransformPreview();return;}
  source.push(c,TRANSFORM_AIR);dest.push(at,v);if(headProfiles.has(c))headSources.push([at,c]);
 }
 if(!source.length){clearTransformPreview();return;}
 const data=new Uint32Array(source.length+dest.length);data.set(source);data.set(dest,source.length);
 transformPreview=true;worker.postMessage({type:'transformPreview',model:modelId,data,headSources},[data.buffer]);
}
const includeBoxEntities=()=>entities.visible()&&$('boxIncludeEntities').checked;
const entitySelection=()=>includeBoxEntities()?boxEntities.map(({index,revision})=>({index,revision})):[];
function captureBoxEntities(region){boxEntities=region&&includeBoxEntities()?entities.inRegion(region):[];}
function boxEntityPreview(){
 if(!boxEntities.length)return null;
 return new Map(boxEntities.map(row=>{
  if(drag?.steps&&drag.nav==='rotate'){
   const pos=turnCell(row.pos.map(v=>v-.5),drag).map(v=>v+.5);
   return [row.index,row.rotationMode==='fixed'?{pos}:{pos,rotation:[row.rotation[0]-drag.steps*90,row.rotation[1]]}];
  }
  if(drag?.steps&&drag.nav==='gizmo'){const pos=row.pos.slice();pos[drag.axis]+=drag.steps;return [row.index,{pos}];}
  return [row.index,{}];
 }));
}
function selectionYawOnly(){return blueprint?Boolean(blueprint.item.entityCount||blueprint.item.entityOnly||blueprint.entities?.length):boxEntities.length>0;}
function refreshEntityRows(data,indices){
 model.entities=data.entities;entities.setRows(data.entityList);
 boxEntities=includeBoxEntities()?entities.matchGroup(boxEntities,indices):[];
 selectionUI();status();dirty();
}
function rangeText(r){return r?`Y ${r.lo[1]}–${r.hi[1]}（${r.hi[1]-r.lo[1]+1} 层）`:'';}
function selectionUI(){const count=selectedCount(),n=blueprint?.origin?(blueprint.visibleCount??blueprint.item.count):count+boxEntities.length;templateButtons();$('transformPanel').classList.toggle('is-empty',n===0);$('contextTool').textContent=blueprint?'蓝图':mode==='extrude'?'挤出':'框选';$('stepHeading').textContent=mode==='extrude'?'挤出方向':'平移';$('selectionTitle').textContent=blueprint?.origin?`蓝图 ${n} 格`:`已选 ${count} 格${boxEntities.length?` · ${boxEntities.length} 实体`:``}`;$('selectionRange').textContent=rangeText(selectionRegion);const yawOnly=mode==='box'&&selectionYawOnly(),takingCoordinates=Boolean(commandBar.picking());
 for(const b of $('transformPanel').querySelectorAll('[data-axis],[data-turn]'))b.disabled=takingCoordinates||!n||pending||mode==='box'&&boxDraft()||(yawOnly&&b.dataset.turn!==undefined&&b.dataset.turn!=='1');
 $('boxIncludeEntities').disabled=takingCoordinates||pending||Boolean(flight)||!entities.visible();
 $('cornerA').disabled=$('cornerB').disabled=$('pickPivot').disabled=$('deselect').disabled=takingCoordinates;
 $('boxPanel').hidden=mode!=='box'||Boolean(blueprint);$('rotateControls').hidden=mode!=='box';$('pickPivot').setAttribute('aria-pressed',String(pickingPivot));$('resetPivot').disabled=takingCoordinates||(!pivot&&!lastTurn&&!pickingPivot);
 $('pivotText').textContent=pickingPivot?'点击方块或当前层空位设置轴心':pivot?`轴心：${coord(pivot)}`:'轴心：选区中心';
 if(yawOnly)$('pivotText').textContent+=' · 含实体，仅可绕 Y 轴旋转';
}
function sendTransform(axis,steps,rotation){
 if(!steps||pending||commandBar.picking()||mode==='box'&&boxDraft())return;
 if(rotation&&axis!==1&&selectionYawOnly()){note('含实体的选区仅可绕 Y 轴旋转。',true);return;}
 if(blueprint?.origin){blueprint.past.push(blueprintSnapshot());blueprint.future.length=0;Object.assign(blueprint,blueprintPose(rotation?{...rotation,nav:'rotate',steps}:{nav:'gizmo',axis,steps}));lastTurn=rotation?{axis,pivot:rotation.pivot}:null;selectionUI();canvas.focus();dirty();return;}
 const selected=[...activeSelection()];if(!selected.length&&!boxEntities.length)return;const delta=[0,0,0];delta[axis]=steps;
 moveRegion=rotation?{rotation:{...rotation,steps}}:selectionRegion?{tool:mode,delta}:null;pending=true;updateDraft();note('');
 const motion=rotation?{tool:'rotate',axis,pivot:rotation.pivot,turns:steps,region:selectionRegion}:{tool:mode==='extrude'?'extrude':'move',delta};
 vscode.postMessage({type:'edit',edit:{...motion,selection:selected,entitySelection:entitySelection(),includeInvisible:showInvisible,allowMoveNbt:$('moveTile').checked,...overwriteSettings()}});
}
function chooseVoxel(p,multi){lastTurn=null;selectionRegion=null;boxEntities=[];if(!multi)selection.clear();if(p&&selectable(idAt(p))){const c=cell(p);if(multi&&selection.has(c))selection.delete(c);else if(selection.size<262144)selection.add(c);}setCorners(null);}
function regionOf(a,b){return {lo:a.map((n,i)=>Math.min(n,b[i])),hi:a.map((n,i)=>Math.max(n,b[i]))};}
function withY(r){const lo=r.lo.slice(),hi=r.hi.slice(),max=model.size[1]-1;
 lo[1]=clamp(lo[1]+boxY[0],0,max);hi[1]=clamp(hi[1]+boxY[1],0,max);lo[1]=Math.min(lo[1],hi[1]);return {lo,hi};}
function draftCorners(){
 if(drag?.boxFrom&&drag.moved)return [drag.boxFrom,drag.boxTo||drag.boxFrom];
 const a=corner('cornerA');return a?[a,corner('cornerB')||hover||a]:null;
}
function boxDraft(){
 if(blueprint)return false;
 if(drag?.boxFrom&&drag.moved)return true;
 const a=corner('cornerA'),b=corner('cornerB');if(!a&&!b)return false;
 return !selectionRegion||!same(a,selectionRegion.lo)||!same(b,selectionRegion.hi);
}
function draftBox(){const p=draftCorners();return p?withY(regionOf(...p)):null;}
function overlayRegion(){
 if(mode==='view')return viewOverlay?.region;
 if(mode==='box'&&boxDraft())return draftBox();
 return transformMode()?(selectionRegion??selectionBounds()):null;
}
function selectRegion(r,pickEntities=true){
 const {lo,hi}=r,n=lo.reduce((v,x,i)=>v*(hi[i]-x+1),1);
 if(n>262144){note('框选区域过大，请分批操作（最多 262144 格）。',true);return false;}
 const next=new Set();
 for(let y=lo[1];y<=hi[1];y++)for(let z=lo[2];z<=hi[2];z++)for(let x=lo[0];x<=hi[0];x++){const p=[x,y,z],id=idAt(p);if(id<0||selectable(id))next.add(cell(p));}

 lastTurn=null;selection.clear();for(const i of next)selection.add(i);selectionRegion=r;if(pickEntities)captureBoxEntities(r);
 selectionUI();dirty();return true;
}
function setCorners(region){
 $('cornerA').value=region?coord(region.lo):'';$('cornerB').value=region?coord(region.hi):'';boxY=[0,0];boxHint();selectionUI();dirty();
}
function boxSelect(a,b){
 if(!selectRegion(withY(regionOf(a,b))))return false;
 setCorners(selectionRegion);return true;
}
function adjustRegionY(steps,lower){
 if(mode==='box'&&boxDraft()){
  const base=draftCorners();if(!base){note('先点选第一个角，再用 Alt + 滚轮调整选框的 Y 范围。',true);return;}
  const ref=regionOf(...base),r=withY(ref);
  if(lower)boxY[0]=clamp(r.lo[1]-steps,0,r.hi[1])-ref.lo[1];
  else boxY[1]=clamp(r.hi[1]+steps,r.lo[1],model.size[1]-1)-ref.hi[1];
  boxHint();$('coords').textContent='选框 '+rangeText(withY(ref));dirty();return;
 }
 const now=selectionRegion||selectionBounds();if(!now){note('先选择方块或框选区域。',true);return;}
 const lo=now.lo.slice(),hi=now.hi.slice();
 if(lower)lo[1]=clamp(lo[1]-steps,0,hi[1]);else hi[1]=clamp(hi[1]+steps,lo[1],model.size[1]-1);
 if(selectRegion({lo,hi})){setCorners(selectionRegion);$('coords').textContent='选框 '+rangeText({lo,hi});}
}
function ray(ev){
 if(!camera)return null;const r=canvas.getBoundingClientRect(),{eye,right,up,back}=pose(),t=Math.tan(fov/2),nx=(2*(ev.clientX-r.left)/r.width-1)*t*r.width/r.height,ny=(1-2*(ev.clientY-r.top)/r.height)*t;
 return {eye,d:unit(plus(times(back,-1),plus(times(right,nx),times(up,ny))))};
}
const fullHitBox=[0,0,0,1,1,1],gridHitIndex=collisionIndex({blocks:{},shapes:[fullHitBox]});
const markerBox=r=>[.5-r,.5-r,.5-r,.5+r,.5+r,.5+r];
const airHitBox=markerBox(.125),voidHitBox=markerBox(.0625);
function trace(ev,skipFluids=false,markers=null){
 const r=ray(ev),native=prefs.resource?.kind==='jar'&&!collisionError,index=native?collisions:gridHitIndex;
 if(!r||!index)return null;
 const fluids=!skipFluids&&$('selectFluid').checked;
 const hit=traceCollision(r,model.size,index,p=>{
  if(!availableLayer(p[1]))return null;
  const state=model.states[(value(p)>>1)-1];
  if(!state||AIR.has(state.name)){
   if(!markers||(!state&&markers!=='all'))return null;
   return !state||state.name===STRUCTURE_VOID?voidHitBox:airHitBox;
  }
  if(FLUID.has(state.name))return fluids?fullHitBox:null;
  if(!native)return fullHitBox;
  const shape=index.shape(state);
  return shape?.length?shape:state.name==='minecraft:light'?airHitBox:null;
 });
 return hit?{...r,...hit}:r;
}
function targetEntity(e){
 if(blueprint||sampleReturn||pending||entities.picking()||!['view','pick'].includes(mode)||!entities.visible())return null;
 const t=trace(e);return entities.hit(t,availableLayer,t?.p?t.distance+.12:Infinity);
}
function workplane(t,expand=false){if(!t||Math.abs(t.d[1])<1e-8)return null;const u=(layer+.015-t.eye[1])/t.d[1];if(u<0)return null;const p=[Math.floor(t.eye[0]+t.d[0]*u),layer,Math.floor(t.eye[2]+t.d[2]*u)];return (expand?placeBounds(p):bounds(p))?p:null;}
function placeBounds(p){return p&&p.every((v,i)=>Number.isInteger(v)&&v>=-1&&v<=model.size[i]);}
function commandPointAt(e){
 const rect=canvas.getBoundingClientRect();
 if(e.clientX<rect.left||e.clientX>=rect.right||e.clientY<rect.top||e.clientY>=rect.bottom)return null;
 const t=trace(e),p=t?.p?(e.altKey?plus(t.p,t.n):t.p):workplane(t);
 return bounds(p)?p:null;
}
function entityPositionAt(e){const t=trace(e),p=t?.p?plus(t.p,t.n):workplane(t);return bounds(p)?p:null;}
function pickHint(){
 $('startPick').title=prefs.resource?.kind!=='jar'?'取样（未选择 JAR，按整格取样）':(collisionError?collisionError+'；目前按整格取样':null)??(collisions?'按原版碰撞箱或方块轮廓取样':'正在读取原版方块形状…');
 document.querySelector('[data-tool=pick]').title=$('startPick').title;
}
function target(ev){const t=trace(ev,false,!showInvisible?null:mode==='box'?'all':mode==='erase'?'air':null);if(!t)return null;let p;
 if(mode==='place'){p=t.p?plus(t.p,t.n):workplane(t,true);if(p&&slice!=='full'&&!availableLayer(p[1]))p=workplane(t,true);return placeBounds(p)?p:null;}
 else if(mode==='box')p=t.p||workplane(t);
 else p=t.p;
 return bounds(p)?p:null;
}
function markSwatch(button,selected){if(button){button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));}}
function select(i){
 const st=model?.states[i];if(!st)return;
 const grid=$('swatches');markSwatch(grid.querySelector('.active'),false);markSwatch(grid.querySelector(`[data-state="${i}"]`),true);
 active=i;setBrushState(st);updateDraft();
}
function drawPalette(){
 const grid=$('swatches'),scroll=grid.scrollTop;thumbnailObserver?.disconnect();grid.replaceChildren();const q=$('filter').value.trim().toLowerCase();if(!model)return;
 let total=0;for(const [i,s] of model.states.entries()){
  if(s.name===STRUCTURE_VOID)continue;
  const pl=Object.entries(s.props).map(p=>p.join('=')).join(', '); if(!(`${s.name} ${pl}`).includes(q))continue;
  if(total++===320)break; const b=document.createElement('button');b.title=pl?`${s.name}[${pl}]`:s.name;b.setAttribute('aria-label',b.title);b.style.backgroundColor=rgba(swatches[i]);b.dataset.state=i;markSwatch(b,i===active);b.addEventListener('click',()=>select(i));grid.append(b);
  if(AIR.has(s.name)){b.textContent='·';b.style.backgroundColor='';}
  else thumbnailObserver?.observe(b);
 }
 grid.scrollTop=scroll;
}
const sidebarTabs=[...document.querySelectorAll('[data-sidebar]')];
const splitter=$('sidebarSplitter'),sidebar=$('editorSidebar'),layout=splitter.parentElement;
const sidebarSize={...vscode.getState?.()?.sidebarSize};
for(const axis of ['width','height'])if(Number.isFinite(sidebarSize[axis]))layout.style.setProperty(`--sidebar-${axis}`,`${sidebarSize[axis]}px`);
let resizeSidebar=null;
function sidebarMetrics(){
 const style=getComputedStyle(layout),vertical=style.getPropertyValue('--sidebar-axis').trim()==='y';
 const axis=vertical?'height':'width',space=vertical?layout.clientHeight:layout.clientWidth-parseFloat(style.getPropertyValue('--tools-width'));
 const max=Math.max(0,Math.round(space-parseFloat(style.getPropertyValue('--splitter-size'))-parseFloat(style.getPropertyValue('--viewport-min'))));
 const min=Math.min(max,parseFloat(style.getPropertyValue('--sidebar-min')));
 return {axis,vertical,min,max,size:Math.round(sidebar.getBoundingClientRect()[axis])};
}
function describeSplitter(){
 const {vertical,min,max,size}=sidebarMetrics();splitter.setAttribute('aria-orientation',vertical?'horizontal':'vertical');
 splitter.setAttribute('aria-valuemin',min);splitter.setAttribute('aria-valuemax',max);splitter.setAttribute('aria-valuenow',size);
}
function setSidebarSize(metrics,size){
 const px=clamp(Math.round(size),metrics.min,metrics.max);sidebarSize[metrics.axis]=px;
 layout.style.setProperty(`--sidebar-${metrics.axis}`,`${px}px`);splitter.setAttribute('aria-valuenow',px);
}
function saveSidebarSize(){vscode.setState?.({...vscode.getState?.(),sidebarSize});}
function splitterPosition(e,metrics){return metrics.vertical?e.clientY:e.clientX;}
splitter.addEventListener('pointerdown',e=>{
 if(e.button!==0||resizeSidebar)return;
 const metrics=sidebarMetrics();resizeSidebar={id:e.pointerId,metrics,start:splitterPosition(e,metrics)};
 splitter.focus();splitter.setPointerCapture(e.pointerId);splitter.dataset.resizing='';e.preventDefault();
});
splitter.addEventListener('pointermove',e=>{
 if(resizeSidebar?.id!==e.pointerId)return;
 const {metrics,start}=resizeSidebar;setSidebarSize(metrics,metrics.size+start-splitterPosition(e,metrics));
});
splitter.addEventListener('lostpointercapture',e=>{
 if(resizeSidebar?.id!==e.pointerId)return;
 resizeSidebar=null;delete splitter.dataset.resizing;saveSidebarSize();
});
splitter.addEventListener('keydown',e=>{
 const m=sidebarMetrics(),more=m.vertical?'ArrowUp':'ArrowLeft',less=m.vertical?'ArrowDown':'ArrowRight';
 const size=e.key===more?m.size+10:e.key===less?m.size-10:e.key==='Home'?m.min:e.key==='End'?m.max:null;
 if(size===null)return;e.preventDefault();setSidebarSize(m,size);saveSidebarSize();
});
new ResizeObserver(describeSplitter).observe(layout);
function showSidebar(page,focus=false){
 if(page!=='entities'&&drag?.subject)cancelDrag({pointerId:drag.id});
 if(page!=='entities'&&entities.picking())entities.stopPick();
 const tab=$('tab-'+page);if(tab.getAttribute('aria-selected')!=='true'){
  for(const b of sidebarTabs){const on=b===tab;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;$('pane-'+b.dataset.sidebar).hidden=!on;}
  document.querySelector('.sidebar-body').scrollTop=0;
  if(page==='entities'&&prefs.resource?.kind==='jar')vscode.postMessage({type:'warmSummon'});
 }
 if(focus)tab.focus();
}
function pickEntityPosition(on){
 if(on){
  entityPickReturn=sampleReturn??mode;sampleReturn=null;drawOverwrite();
  setMode('pick',true);canvas.focus();
 }else if(entityPickReturn){const prev=entityPickReturn;entityPickReturn=null;setMode(prev,true);}
}
function setMode(v,keepSidebar=false){
 if(v!=='pick'&&entities.picking()){entityPickReturn=null;entities.stopPick(false);}
 setFlight(false);
 commandBar.cancel();
 const changed=v!==mode,restoreView=mode==='view'&&viewOverlay?.mode===v;if(changed){
  if(v==='view')viewOverlay={mode,region:overlayRegion(),hover};
  else{
   if(restoreView)hover=viewOverlay.hover;else boxY=[0,0];
   viewOverlay=null;
   if(blueprint&&v!=='box'&&!(v==='pick'&&sampleReturn))clearBlueprint();
  }
  if(!restoreView)hover=null;
  if(drag?.nav==='rotate'||drag?.nav==='gizmo'||drag?.subject)cancelDrag({pointerId:drag.id});pickingPivot=false;if(brush&&!brush.committing)clearBrush();altRemainder=0;
 }
 mode=v;if(changed&&v==='box'&&!blueprint&&!selectionRegion&&!boxDraft()&&selection.size)setCorners(selectionRegion=selectionBounds());$('mode').textContent=names[v];masks.forTool(v);$('transformPanel').hidden=!transformMode();
 if(changed){
  if(!keepSidebar&&!restoreView&&['place','paint','box'].includes(v)&&!blueprint)showSidebar('blocks');
  if(transformMode()){$('transformPanel').open=true;document.querySelector('.sidebar-body').scrollTop=0;}
 }
 selectionUI();for(const b of document.querySelectorAll('[data-tool]'))b.setAttribute('aria-pressed',String(b.dataset.tool===mode));
 canvas.classList.remove('entity-hover');canvas.classList.toggle('grab',mode==='view');boxHint();dirty();
}
function blockChoices(){return [...new Set([...registryBlocks,...(model?.states.map(s=>s.name)??[])])];}
function blockPreview(host,state){
 if(AIR.has(state.name)){host.textContent='∅';host.classList.add('empty-image');return;}
 const swatch=color(state);host.style.backgroundColor=rgba(swatch);thumbnails?.show(host,state,swatch,textureOn?materials:null);
}
function setBrushState(st){$('name').value=brushName=st.name;setBrushProps(st.props);refreshBrush();}
const brushPresetMenu=$('brushPresetMenu');
function positionBrushPresets(){
 const picker=$('brushPreset'),rect=picker.getBoundingClientRect(),area=picker.closest('.sidebar-body').getBoundingClientRect();
 if(rect.bottom<=area.top||rect.top>=area.bottom){brushPresetMenu.hidePopover();return;}
 const below=innerHeight-rect.bottom,above=rect.top,up=below<160&&above>below;
 Object.assign(brushPresetMenu.style,{left:`${rect.left}px`,width:`${rect.width}px`,
  top:up?'auto':`${rect.bottom+2}px`,bottom:up?`${innerHeight-rect.top+2}px`:'auto',
  maxHeight:`${Math.min(220,(up?above:below)-6)}px`});
}
brushPresetMenu.addEventListener('beforetoggle',e=>{if(e.newState==='open')positionBrushPresets();});
const updateBrushPresetsPosition=()=>{if(brushPresetMenu.matches(':popover-open'))positionBrushPresets();};
document.addEventListener('scroll',updateBrushPresetsPosition,true);
window.addEventListener('resize',updateBrushPresetsPosition);
function showBrushPresets({builtin,custom}){
 const activeRow=document.activeElement?.closest('.brush-preset-row');
 const rowIndex=[...brushPresetMenu.querySelectorAll('.brush-preset-row')].indexOf(activeRow);
 const fragment=document.createDocumentFragment();
 for(const [title,items,removable] of [['内置',builtin,false],['本地',custom,true]]){
  if(!items.length)continue;
  const group=document.createElement('div');group.className='brush-preset-group';group.textContent=title;fragment.append(group);
  for(const {label,state} of items){
   const row=document.createElement('div');row.className='brush-preset-row';
   const choice=document.createElement('button');choice.type='button';choice.className='brush-preset-choice';choice.textContent=choice.title=label;
   choice.onclick=()=>{setBrushState(state);brushPresetMenu.hidePopover();$('brushPreset').focus();};
   row.append(choice);
   if(removable){
    const remove=document.createElement('button');remove.type='button';remove.className='brush-preset-remove';remove.textContent='-';
    remove.title=`删除预设「${label}」`;remove.setAttribute('aria-label',remove.title);
    remove.onclick=()=>vscode.postMessage({type:'deleteBrushPreset',label});row.append(remove);
   }
   fragment.append(row);
  }
 }
 const scroll=brushPresetMenu.scrollTop;brushPresetMenu.replaceChildren(fragment);brushPresetMenu.scrollTop=scroll;
 if(rowIndex>=0&&brushPresetMenu.matches(':popover-open')){
  const choices=brushPresetMenu.querySelectorAll('.brush-preset-choice');choices[Math.min(rowIndex,choices.length-1)]?.focus();
 }
}
$('saveBrushPreset').onclick=()=>{
 try{vscode.postMessage({type:'saveBrushPreset',state:readState()});}catch(e){note(e.message,true);}
};
function setBrushProps(props){$('props').value=Object.entries(props).map(([k,v])=>`${k}=${v}`).join(', ');}
function brushState(){try{return readState();}catch{return null;}}
function refreshBrush(refreshPreview=true){
 const st=brushState(),form=$('brushStateForm');
 if(st){renderStateRows(form,st.props,propertySchema(st),{prefix:'brush_',change(key,value){
  const next=brushState();if(!next)return;
  if(value===null)delete next.props[key];else Object.defineProperty(next.props,key,{value,enumerable:true,configurable:true});
  setBrushProps(next.props);brushPicker?.refresh();
 }});}else form.replaceChildren();
 if(refreshPreview)brushPicker?.refresh();
}
function mountBrushPicker(){
 const field=$('name'),parent=field.parentNode;
 brushPicker=createBlockPicker(field,{choices:()=>blockChoices().filter(n=>n!==STRUCTURE_VOID),preview:blockPreview,value:brushState,known:id=>Object.hasOwn(blockSchema,id)||Boolean(model?.states.some(s=>s.name===id)),onInput(raw){
  const id=blockId(raw);
  if(id!==brushName){$('props').value='';brushName=id;}
  refreshBrush(false);
 }});
 parent.append(brushPicker.root);$('props').oninput=()=>refreshBrush();refreshBrush();
}
function readState(){
 const name=blockId($('name').value),props={};if(!name)throw new Error('方块 ID 无效。');
 if(name===STRUCTURE_VOID)throw new Error('结构空位只能用擦除生成，不能作为画笔方块。');
 for(const part of $('props').value.split(',').map(s=>s.trim()).filter(Boolean)){
  const m=/^([a-z0-9_]+)\s*=\s*([a-zA-Z0-9_.:/+-]+)$/.exec(part);if(!m)throw new Error('属性请按 axis=y, waterlogged=false 的格式填写。');Object.defineProperty(props,m[1],{value:m[2],enumerable:true,configurable:true});
 }
 return {name,props};
}
function stateInput(){
 const {name,props}=readState(),old=model.states[active];return old&&old.name===name&&Object.keys(old.props).length===Object.keys(props).length&&Object.entries(props).every(([k,v])=>old.props[k]===v)?active:{name,props};
}
function corner(id){const s=$(id).value.trim();if(!s)return null;const p=s.split(/[\s,，]+/).map(Number);return model&&p.length===3&&bounds(p)?p:null;}
function boxHint(){
 const a=corner('cornerA'),b=corner('cornerB'),draft=boxDraft(),r=mode==='box'?overlayRegion():null;
 const size=r&&r.lo.map((v,i)=>r.hi[i]-v+1).join(' × '),takingCoordinates=Boolean(commandBar.picking());
 $('boxHint').textContent=!r?'拖出选框或点两个角；双击可选单格。':`${draft?'预览':'选区'} ${size} · ${rangeText(r)}`;
 $('confirmBox').disabled=takingCoordinates||!a||!b||!draft||pending;
 $('apply').disabled=takingCoordinates||Boolean(blueprint||pending||!(draft?a&&b:selectionRegion));
}
function updateDraft(){commandBar.update(!model||pending||fatal||Boolean(brush)||Boolean(blueprint),Boolean(flight));for(const id of ['save','upgradeStructure','snbtMode','resize','paletteAdd','paletteDelete','paletteClean','paletteState','tileSave','tileDelete','initTile'])$(id).disabled=fatal||!model||pending||Boolean(brush)||Boolean(flight);
 if(model){$('paletteDelete').disabled||=model.count<=1;$('paletteState').disabled||=active<0;}
 boxHint();selectionUI();inspector.buttons();tileTree.buttons();entities.buttons();updateSnbt();}
const commandBar=createStructureCommands({context:()=>{
 const region=selectionRegion,single=selection.size===1?positionOf(selection.values().next().value):region&&same(region.lo,region.hi)?region.lo:null;
 const sampled=inspectCell===null?null:positionOf(inspectCell),schema=nbtSchema();
 return {region,point:single??sampled,pointAbove:single?selectable(idAt(single)):!!sampled,eye:camera?pose().eye:[0,0,0],blockIds:blockChoices(),states:blockSchema,
  tileTypes,blockTags:masks.blockTags(),entityIds:entities.types()??(schema?.catalog.registries.entity_type??[]).map(id=>'minecraft:'+id),schema};
},prewarm:()=>{if(prefs.resource?.kind==='jar')vscode.postMessage({type:'warmSummon'});},notify:note,onPickingChange(active){
 if(drag&&(active||drag.commandPoint))cancelDrag({pointerId:drag.id});
 hover=null;canvas.classList.remove('entity-hover');canvas.classList.toggle('command-pick',active);
 $('mode').textContent=active?'取坐标':names[mode];$('coords').textContent='—';
 if(active)canvas.focus({preventScroll:true});
 boxHint();selectionUI();dirty();
},execute(command,commandText){
 if(!model||!camera||pending||fatal||flight||brush||drag||blueprint)return;
 if(command.cmd==='summon'){
  if(prefs.resource?.kind!=='jar')throw new Error('/summon 需要选择原版客户端 JAR。');
  if(!command.pos.every((v,i)=>v>=0&&v<model.size[i]))throw new Error('实体坐标位于结构边界之外。');
  requestLayout({kind:'entity',action:'add',id:command.id,pos:command.pos,snbt:command.snbt},commandText);return;
 }
 if(!command.box.every(bounds))throw new Error('方块坐标位于结构边界之外。');
 for(const {name,props,tag} of [command.state,...(command.blockFilter?[command.blockFilter]:[])]){
  if(tag){if(prefs.resource?.kind!=='jar')throw new Error('#方块标签筛选需要原版客户端 JAR。');continue;}
  if(!blockChoices().includes(name))throw new Error('未知方块：'+name);
  const spec=blockSchema[name];
  if(spec)for(const [key,value] of Object.entries(props))if(!spec[key]?.values.includes(value))throw new Error(`无效的方块状态：${key}=${value}`);
 }
 pending=true;updateDraft();note('');
 vscode.postMessage({type:'edit',commandText,edit:{tool:'fill',box:command.box,state:command.state,commandMode:command.mode,blockFilter:command.blockFilter,snbt:command.snbt,allowNbt:$('overwrite').checked}});
}});
function requestLayout(layout,commandText){if(!model||pending||fatal)return;pending=true;updateDraft();note('');vscode.postMessage({type:'layout',layout,commandText});}
function updateSnbt(){
 const text=$('snbtText'),locked=snbtReading||pending||fatal;
 text.readOnly=locked||!snbtRevision;$('snbtApply').disabled=text.readOnly||text.value===snbtBase;
 $('snbtReload').disabled=locked;
 $('snbtReload').textContent=snbtRevision&&text.value!==snbtBase?'重新读取（丢弃草稿）':'重新读取';
}
function snbtStatus(message,error=false){const status=$('snbtStatus');status.textContent=message;status.classList.toggle('error',error);}
function readSnbt(){if(snbtReading||pending)return;snbtReading=true;snbtStatus('正在读取结构 SNBT…');updateSnbt();vscode.postMessage({type:'snbt'});}
$('upgradeStructure').onclick=()=>{
 if(!model||pending||fatal||flight||brush||blueprint||drag)return;
 pending=true;updateDraft();vscode.postMessage({type:'upgradeStructure'});
};
$('snbtMode').onclick=()=>{
 if(!model||pending||fatal||flight)return;
 $('snbtDialog').showModal();if(snbtRevision&&$('snbtText').value!==snbtBase){snbtStatus('草稿未应用。应用后还需保存 NBT 文件。');updateSnbt();return;}
 readSnbt();
};
$('snbtClose').onclick=()=>$('snbtDialog').close();
$('snbtReload').onclick=readSnbt;$('snbtText').oninput=updateSnbt;
bindNbtCompletion($('snbtText'),()=>{const ctx=nbtSchema();return ctx?{ctx,root:'structure'}:null;});
$('snbtApply').onclick=()=>{
 if($('snbtApply').disabled)return;
 snbtStatus('正在验证结构…');requestLayout({kind:'snbt',revision:snbtRevision,text:$('snbtText').value});
};
function openSize(){if(!model||pending)return;for(const [i,k] of ['X','Y','Z'].entries())$('size'+k).value=model.size[i];if(!$('sizeDialog').open)$('sizeDialog').showModal();}
function refreshTile(reset=false){
 if(reset){tileTree.load(null);$('tileEditor').hidden=true;$('tilePath').value='';$('tileValue').value='';$('tileHint').textContent='';}
 $('missingEntity').hidden=true;
 const st=currentState();$('noEntity').hidden=!st;$('noEntity').textContent='读取 NBT…';
 if(st)vscode.postMessage({type:'inspect',cell:inspectCell});else{tileTree.load(null);$('tileEditor').hidden=true;}
}
function nestedTileHints(path){
 const parent=path.split('.').slice(0,-1);if(!parent.length||parent.length>7||!parent.every(k=>/^[-_A-Za-z0-9]+$/.test(k)))return [];
 const spec=tileTree.context(parent);if(!spec)return [];
 return nbtFields(spec.ctx,spec.root,spec.base,parent).filter(f=>/^[-_A-Za-z0-9]+$/.test(f.key)).map(f=>[[...parent,f.key].join('.'),tagTypes[f.type],f.text,f.desc]);
}
function drawTilePaths(){
 const path=$('tilePath').value.trim(),hints=new Map(tileHints);
 for(const row of nestedTileHints(path))if(!hints.has(row[0]))hints.set(row[0],row);
 $('tileFields').replaceChildren();
 for(const [field,row] of hints){const op=document.createElement('option');op.value=field;op.label=row[1]+(row[3]?' · '+row[3]:'');$('tileFields').append(op);}
}
function tileFieldHint(path){return tileHints.get(path)??nestedTileHints(path).find(r=>r[0]===path);}
function tileField(){if(inspectCell===null)return;const path=$('tilePath').value.trim(),row=tileFieldHint(path);
 $('tileHint').textContent=row?`${row[1]}${row[3]?' · '+row[3]:''}`:'';$('tileValue').value='';
 if(/^[-_A-Za-z0-9]+(?:\.[-_A-Za-z0-9]+){0,7}$/.test(path))vscode.postMessage({type:'tileValue',cell:inspectCell,path});
}
function applyTile(remove){if(pending||flight||fatal||inspectCell===null||$('tileEditor').hidden)return;if(!$('tileAdvanced').open){$('tileAdvanced').open=true;$('tilePath').focus();return;}const path=$('tilePath').value.trim();if(!path)return;
 pending=true;updateDraft();note('');vscode.postMessage({type:'edit',edit:{tool:'tile',cell:inspectCell,path,text:$('tileValue').value,remove,allowTypeChange:$('tileType').checked}});
}
function showTile(info){
 const missing=info?.canInitialize===true;
 $('missingEntity').hidden=!missing;$('noEntity').hidden=Boolean(info&&!missing);$('noEntity').textContent=missing?'缺少 NBT':'无 NBT';
 if(!info||missing){
  const st=currentState();if(st)$('inspect').textContent=coord(positionOf(inspectCell))+'  '+st.name+'\n'+(missing?'可初始化 '+info.type:'无方块实体');
  tileTree.load(null);$('tileEditor').hidden=true;return;
 }
 $('inspect').textContent=coord(positionOf(inspectCell))+'  '+(info.data?.id||'方块实体')+'\n'+JSON.stringify(info.data,null,2);
 const suggested=hints(info.data?.id,info.dv);
 tileTree.load({...info,id:info.data?.id});
 const spec=tileTree.context();if(spec)for(const f of nbtFields(spec.ctx,spec.root,spec.base))if(!['id','x','y','z'].includes(f.key)&&!suggested.some(r=>r[0]===f.key))suggested.push([f.key,tagTypes[f.type],f.text,f.desc]);
 tileHints=new Map(suggested.map(row=>[row[0],row]));
 for(const {name,type} of info.fields)if(!['id','x','y','z'].includes(name)){
    const row=tileHints.get(name);tileHints.set(name,[name,tagTypes[type],row?.[2],row?.[3]]);
 }
 drawTilePaths();$('tileEditor').hidden=false;
}

bindNbtCompletion($('tileValue'),()=>{const path=$('tilePath').value.trim();return path?tileTree.context(path.split('.')):null;});

function fillSelection(){
 if(mode!=='box'||!model||pending||fatal||blueprint||drag||commandBar.picking())return;
 const a=corner('cornerA'),b=corner('cornerB');
 if(boxDraft()&&(!a||!b||!boxSelect(a,b)))return;
 if(!selectionRegion)return;
 try{
  const {lo,hi}=selectionRegion,state=stateInput(),mask=masks.active('fill')?.spec;
  pending=true;updateDraft();vscode.postMessage({type:'edit',edit:{tool:'fill',box:[lo,hi],state,mask,allowNbt:$('overwrite').checked}});
 }catch(e){note(e.message,true);}
}

function startBrush(e){
 if(pending||brush)return;
 try{
  const tool=mode,state=tool==='erase'?null:stateInput(),custom=state&&typeof state==='object';
  const id=custom?BRUSH_PREVIEW:state,st=custom?state:model.states[id];
  const mask=masks.active(tool);
  const edit={tool,state,mask:mask?.spec,eraseInvisible:tool==='erase'&&showInvisible,allowNbt:$('overwrite').checked,mx:$('mx').checked,mz:$('mz').checked};
  const current=brush={id,st,mask:mask?.rule,edit,points:new Map(),seen:new Set(),batch:[],committing:false};
  if(custom){
   worker.postMessage({type:'brushState',model:modelId,id,state:st,color:color(st)});
   if(textureOn&&materials)materials.state(st).then(async style=>{
    await materials.idle();if(brush===current&&style&&textureOn)worker.postMessage({type:'brushStyle',model:modelId,id,style});
   });
  }
  note('');updateDraft();sampleBrush(e);
 }catch(e){note(e.message,true);}
}
function sampleBrush(e){
 const current=brush;if(!current||current.committing)return;
 const p=target(e);if(!p||current.points.size>=12000||current.mask&&((current.points.size+1)*(current.edit.mx?2:1)*(current.edit.mz?2:1)*current.mask.cost>maskWorkLimit))return;
 const k=coord(p);if(current.points.has(k))return;current.points.set(k,p);
 const {tool,mx,mz,allowNbt,eraseInvisible}=current.edit;
 const [x,y,z]=p,[w,,d]=model.size,xs=mx?[x,w-1-x]:[x],zs=mz?[z,d-1-z]:[z];
 for(const u of xs)for(const v of zs){
  if(!bounds([u,y,v]))continue;
  const i=cell([u,y,v]);if(current.seen.has(i))continue;current.seen.add(i);
  if(current.mask&&!current.mask.test(maskState,model.size[1],u,y,v))continue;
  const old=cells[i],prev=(old>>1)-1,st=model.states[prev],occupied=st&&!AIR.has(st.name);
  if(tool==='place'&&occupied||tool==='paint'&&!occupied||tool==='erase'&&(!old||(!eraseInvisible&&AIR.has(st?.name))))continue;
  if(old&1&&!allowNbt&&(tool==='erase'||model.count>1||st?.name!==current.st?.name))continue;
  if(tool!=='erase'&&prev===current.id)continue;
  current.batch.push(i,tool==='erase'?0:(current.id+1)*2);
 }
 if(current.batch.length&&!brushFrame)brushFrame=requestAnimationFrame(flushBrush);
}
const maskState=(x,y,z)=>model.states[(value([x,y,z])>>1)-1]||maskAir;
function flushBrush(){
 if(brushFrame)cancelAnimationFrame(brushFrame);brushFrame=0;
 if(!brush?.batch.length)return;
 const data=Uint32Array.from(brush.batch);brush.batch.length=0;
 worker.postMessage({type:'brushPreview',model:modelId,data},[data.buffer]);
}
function clearBrush(){
 if(!brush)return;
 if(brushFrame)cancelAnimationFrame(brushFrame);brushFrame=0;brush=null;
 worker?.postMessage({type:'brushClear',model:modelId});updateDraft();
}
function commitBrush(e){
 if(!brush||brush.committing)return;
 sampleBrush(e);flushBrush();
 if(!brush.points.size){clearBrush();return;}
 brush.committing=true;pending=true;updateDraft();
 vscode.postMessage({type:'edit',edit:{...brush.edit,points:[...brush.points.values()]}});
}
function sweepBrush(e,x,y){
 if(!brush||brush.committing)return;
 // Interpolate on screen, not through the volume: a fast drag must not paint hidden voxels.
 const len=Math.hypot(e.clientX-x,e.clientY-y),pixelStep=clamp(canvas.clientHeight/(3*camera.distance),2,8);
 const n=Math.min(64,Math.ceil(len/pixelStep));
 for(let i=1;i<n;i++)sampleBrush({clientX:x+(e.clientX-x)*i/n,clientY:y+(e.clientY-y)*i/n});
 sampleBrush(e);
}
function pick(p){if(!p)return;const i=idAt(p);if(i<0)return;select(i);const val=value(p);inspectCell=cell(p);$('inspect').textContent=coord(p)+'  '+model.states[i].name+((val&1)?'\n读取 NBT…':'\n无方块实体');refreshTile(true);refreshBlockState(true);showSidebar('inspect');boxHint();}
function clickModel(p){
 if(!p||pending)return;
 if(mode==='pick'){if(sampleReturn){const s=model.states[idAt(p)];if(s){addOverwrite(s.name);const prev=sampleReturn;sampleReturn=null;drawOverwrite();setMode(prev,true);}}else pick(p);return;}
 if(mode==='box'){
  if(!corner('cornerA')||corner('cornerB')){boxY=[0,0];$('cornerA').value=coord(p);$('cornerB').value='';}else $('cornerB').value=coord(p);
  if(corner('cornerA')&&corner('cornerB')){boxSelect(corner('cornerA'),corner('cornerB'));return;}
  boxHint();dirty();return;
 }
}

function layerSet(v){if(!model)return;const n=Number(v);if(!Number.isFinite(n))return;layer=clamp(Math.trunc(n),0,model.size[1]-1);$('layer').value=layer;$('layerRange').value=layer;const next=$('layerMode').value;
 if(slice!==next||next!=='full'){slice=next;epoch++;renderOver=false;clearMarkers();meshes.clear();busy=true;status();worker.postMessage({type:'slice',model:modelId,epoch,mode:slice,layer});}dirty();
}
let layerTimer;function requestLayer(v){$('layer').value=v;$('layerRange').value=v;clearTimeout(layerTimer);layerTimer=setTimeout(()=>layerSet(v),55);}
function loadModel(m,growth){
 commandBar.cancel();
 const shift=p=>p.map((v,i)=>v+growth.offset[i]),oldLayer=layer;
 const prior=growth&&model?{selection:[...selection].map(positionOf),region:selectionRegion,pivot}:null;
 setFlight(false);clearBlueprint();clearBrush();clearTransformPreview();drag=null;viewOverlay=null;inspectorPending=null;inspector.state(null);tileTree.load(null);canvas.classList.remove('drag');
 const refresh=model&&!model.size.some((n,i)=>n!==m.size[i]);model=m;const [x,y,z]=m.size;masks.templateHeight(y);
 modelId++;epoch++;renderOver=false;clearMarkers();meshes.clear();cells=new Uint32Array(x*y*z);const a=unpack(m.voxels);for(let i=0;i<a.length;i+=2)cells[a[i]]=a[i+1];
 const maskCells=m.maskCells?unpack(m.maskCells):null;
 if(maskCells){for(let i=0;i<maskCells.length;i+=2)cells[maskCells[i]]=maskCells[i+1];delete model.maskCells;}
 layer=prior?clamp(oldLayer+growth.offset[1],0,y-1):refresh?clamp(layer,0,y-1):0;$('layer').max=$('layerRange').max=y-1;$('layer').value=$('layerRange').value=layer;
 swatches=m.states.map(color);active=-1;inspectCell=null;pending=false;hover=null;selection.clear();selectionRegion=null;boxEntities=[];boxY=[0,0];moveRegion=null;pivot=lastTurn=null;pickingPivot=false;sampleReturn=null;drawOverwrite();$('tileEditor').hidden=true;$('stateEditor').hidden=true;$('entityPanel').hidden=true;$('inspectEmpty').hidden=false;$('inspect').textContent='用取样工具点击方块。';$('cornerA').value=$('cornerB').value='';
 $('dimensions').textContent=`${x} × ${y} × ${z}`;
 const pal=$('palette');pal.replaceChildren();for(let i=0;i<m.count;i++){const o=document.createElement('option');o.value=i;o.textContent=`变体 ${i+1}`;pal.append(o);}pal.value=m.palette;
 if(prior){
  if(camera)camera.target=shift(camera.target);
  for(const c of growth.selection??prior.selection.map(shift).filter(bounds).map(cell))selection.add(c);
  if(prior.region&&!growth.selection){const lo=shift(prior.region.lo),hi=shift(prior.region.hi);if(bounds(lo)&&bounds(hi)){selectionRegion={lo,hi};setCorners(selectionRegion);}}
  if(mode==='box'&&!selectionRegion&&selection.size)setCorners(selectionRegion=selectionBounds());
  if(prior.pivot)pivot=shift(prior.pivot);
 }else if(!refresh){const first=m.states.findIndex(s=>!AIR.has(s.name)&&!FLUID.has(s.name));if(first>=0)select(first);reset();}drawPalette();refreshBrush();
 busy=true;status();selectionUI();updateDraft();note('正在生成预览…',false,true);
 worker.postMessage({type:'model',model:modelId,epoch,mode:slice,layer,size:m.size,states:m.states,voxels:m.voxels,maskCells,colors:swatches,game:gameRender,showInvisible},maskCells?[maskCells.buffer]:[]);
 headProfiles=new Map(m.headProfiles??[]);delete model.voxels;dirty();void applyMaterials();
}
async function headSkinUVs(profiles){
 if(!materials?.heads||!textureOn||!profiles)return [];
 return (await Promise.all([...profiles].map(async ([cell,profile])=>[cell,await materials.skinUv(skins.appearance(profile,skinDefaults))]))).filter(([,uv])=>uv);
}
async function refreshHeadSkins(){
 if(!model||!materials?.heads||!textureOn)return;
 const run=++headRun,mid=modelId,heads=await headSkinUVs(headProfiles);
 if(run===headRun&&mid===modelId&&textureOn)worker.postMessage({type:'headSkins',model:mid,heads});
}
async function applyMaterials(){
 void refreshHeadSkins();
 const run=++matRun,mid=modelId;if(!model||!materials)return;
 drawPalette();renderTemplateList();brushPicker?.refresh();masks.refreshPreviews();
 void meshBlueprint();
 const textured=textureOn,fluidUV=textured?materials.fluidUV():{};$('material').textContent=textured?'材质':'色块';$('material').setAttribute('aria-pressed',String(textured));
 if(textured)$('material').title='正在加载本地模型和贴图…';
 const styles=textured?await Promise.all(model.states.map(s=>materials.state(s))):[];
 if(textured)await materials.idle();if(run!==matRun||mid!==modelId)return;
 if(!textured||styles.some(Boolean)||Object.keys(fluidUV).length){
  epoch++;renderOver=false;busy=true;status();worker.postMessage({type:'styles',model:mid,epoch,styles,fluidUV});
 }
 $('material').title=textured?`本地材质 · ${styles.filter(Boolean).length}/${model.states.length} 个状态有模型 · 点击切换色块`:'色块 · 点击恢复材质';
}
function patch(m){
 const added=(Array.isArray(m.added)?m.added:m.added?[m.added]:[]).map(row=>{
  const state=row.variants?.[model.palette]??row.state;model.states[row.id]=state;swatches[row.id]=color(state);return {id:row.id,state,color:swatches[row.id]};
 });
 if(added.length)drawPalette();
 const isVisible=v=>{const s=model.states[(v>>1)-1];return s&&!AIR.has(s.name);};
 const data=unpack(m.data);for(let i=0;i<data.length;i+=2){const c=data[i],v=data[i+1];model.visible+=Number(Boolean(isVisible(v)))-Number(Boolean(isVisible(cells[c])));cells[c]=v;}
 worker.postMessage({type:'patch',model:modelId,data:m.data,added});status();dirty();
 let skinChanged=false;for(const [cell,profile] of m.headProfiles??[]){if(profile){headProfiles.set(cell,profile);skinChanged=true;}else skinChanged=headProfiles.delete(cell)||skinChanged;}
 if(skinChanged)void refreshHeadSkins();
 if(inspectCell!==null&&data.some((v,i)=>!(i%2)&&v===inspectCell)){refreshTile();refreshBlockState();}
 if(added.length&&textureOn){const mid=modelId,run=matRun;
  Promise.all(added.map(async row=>[row.id,await materials.state(row.state)])).then(async rows=>{await materials.idle();if(mid!==modelId||run!==matRun||!textureOn)return;
   const touched=new Map(rows.filter(([,style])=>style).map(([id])=>[id,[]]));
   for(let i=0;i<cells.length;i++)touched.get((cells[i]>>1)-1)?.push(i);
   for(const [id,style] of rows)if(style)worker.postMessage({type:'style',model:mid,id,style,cells:touched.get(id)});
  });
 }
}
window.addEventListener('message',({data:m})=>{
 if(m.type==='templates'){templates=m.items;for(const id of templateImages.keys())if(!templates.some(t=>String(t.id)===id.split(':')[0]))templateImages.delete(id);if(blueprint&&!pending&&!templates.some(t=>t.id===blueprint.item.id)){clearBlueprint();selectionUI();}else renderTemplateList();}
 if(m.type==='entityRows'&&!fatal&&model)refreshEntityRows(m.data);
 if(m.type==='entityDetails')entities.inspected(m.data);
 if(m.type==='entityModels'){
  entities.setCatalog(m.data,m.error);skinDefaults=m.data?.defaultSkins;
  if(materials&&m.data?.heads){materials.setHeads(m.data.heads);void applyMaterials();if(blueprint?.blocks)void meshBlueprint(true);}
 }
 if(m.type==='playerSkin')skins.receive(m.request,m.skin);
 if(m.type==='collisionShapes'){
  collisions=m.catalog?collisionIndex(m.catalog):null;collisionError=m.error??null;
  if(m.catalog?.schema){blockSchema=m.catalog.schema;registryBlocks=Object.keys(blockSchema);if(m.catalog.tiles)tileTypes=m.catalog.tiles;refreshBrush();refreshBlockState();}
  if(collisionError)note('原版形状不可用，暂用整格选取。'+collisionError,true);
  hover=null;pickHint();dirty();
 }
 if(m.type==='copied'){copyingTemplate=false;showSidebar('templates');templateButtons();note('已复制选区到临时模板。');}
 if(m.type==='previewTemplate'&&blueprint?.item.id===m.id&&blueprint.origin&&!blueprint.blocks){Object.assign(blueprint,{states:m.states,blocks:m.blocks,entities:m.entities??[],headProfiles:m.headProfiles,colors:m.states.map(color)});void meshBlueprint();}
 if(m.type==='model'&&!fatal){try{loadModel(m.data,m.growth);entities.setRows(m.data.entityList);selectionUI();}catch(e){fatal=true;note(e.message,true);updateDraft();}}
 if(m.type==='patch'&&!fatal&&model){
  patch(m);
  if(m.entityRows)refreshEntityRows(m.entityRows,m.entitySelection);
  if(m.selection){lastTurn=null;selection.clear();for(const c of m.selection)selection.add(c);setCorners(selectionRegion=selectionBounds());}
  else if(mode==='box'&&selectionRegion&&!moveRegion)selectRegion(selectionRegion,false);
 }
 if(m.type==='snbt'){
  snbtReading=false;snbtRevision=m.revision;snbtBase=$('snbtText').value=m.text;
  snbtStatus('修改后先点应用，再保存 NBT 文件。');updateSnbt();
 }
 if(m.type==='error'&&['snbt','snbtApply'].includes(m.request)){
  snbtReading=false;pending=false;snbtStatus(m.message,true);updateDraft();return;
 }
 if(m.type==='info'||m.type==='notice')note(m.message,m.type==='info');
 if(m.type==='ack'){commandBar.complete(m.commandText);clearTransformPreview();pending=false;if(m.entity!==undefined){showSidebar('entities');if((entities.selected()?.index??null)!==m.entity)entities.choose(m.entity);}if(m.snbt){snbtRevision=null;snbtBase=$('snbtText').value='';$('snbtDialog').close();note('已应用 SNBT；保存后才会写入文件。');}if(m.pasted)clearBlueprint();if(m.notice)note(m.notice);if(brush?.committing)clearBrush();if(inspectorPending){if(inspectorPending==='state')inspector.submitted();else tileTree.reset();inspectorPending=null;}if(m.selection){selection.clear();for(const c of m.selection)selection.add(c);
  if(moveRegion?.rotation){lastTurn=moveRegion.rotation;const r=selectionRegion,turn=p=>turnCell(p,lastTurn).map((v,i)=>clamp(v,0,model.size[i]-1));selectionRegion=r?regionOf(turn(r.lo),turn(r.hi)):null;}
  else if(moveRegion&&selectionRegion){lastTurn=null;const {delta,tool}=moveRegion;const r=selectionRegion,move=p=>plus(p,delta).map((v,i)=>clamp(v,0,model.size[i]-1));
   selectionRegion=tool==='box'?regionOf(move(r.lo),move(r.hi)):{lo:r.lo.map((v,i)=>Math.min(v,move(r.lo)[i])),hi:r.hi.map((v,i)=>Math.max(v,move(r.hi)[i]))};}
  else lastTurn=null;
  if(mode==='box'&&!selectionRegion)selectionRegion=selectionBounds();
  setCorners(selectionRegion);}moveRegion=null;updateDraft();}
 if(m.type==='inspect'&&inspectCell===m.cell)showTile(m.data);
 if(m.type==='tileValue'&&inspectCell===m.cell&&$('tilePath').value.trim()===m.path){const row=tileFieldHint(m.path);$('tileValue').value=m.data?.text??row?.[2]??'';$('tileHint').textContent=`${m.data?tagTypes[m.data.type]:row?.[1]||'新字段'}${row?.[3]?' · '+row[3]:''}`;}
 if(m.type==='command')runCommand(m.cmd);
 if(m.type==='prefs'){
  prefs=m.prefs||{};pickHint();entities.setJar(prefs.resource?.kind==='jar');masks.prefs(prefs.resource?.kind==='jar');syncRenderPreference();drawSettings();
  if(!materials&&!prefs.resource&&!prefs.materialIntroSeen&&!$('materialIntro').open)$('materialIntro').showModal();
 }
 if(m.type==='brushPresets')showBrushPresets(m);
 if(m.type==='maskCatalog')masks.supply(m.catalog,m.error);
 if(m.type==='error'&&(m.request==='copyTemplate'||m.request==='previewTemplate'||m.request==='dropTemplate')){copyingTemplate=false;if(m.request==='previewTemplate')clearBlueprint();templateButtons();note(m.message,true);return;}
 if(m.type==='error'||m.type==='fatal'){if(m.type==='fatal')setFlight(false);clearBrush();clearTransformPreview();moveRegion=null;pending=false;inspectorPending=null;fatal=m.type==='fatal';note(m.message,true);updateDraft();}
});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();setFlight(false);fatal=true;note('WebGL 上下文已断开。请关闭并重新打开 NBT 页面。',true);updateDraft();});
document.addEventListener('pointerlockchange',()=>{
 if(document.pointerLockElement===canvas){
  if(!flight){document.exitPointerLock();return;}
  flight.locked=true;flight.aim=null;updateFlightHelp();canvas.focus();
 }else if(flight?.locked)setFlight(false,true);
 else if(recenterAfterUnlock){recenterAfterUnlock=false;centerFlightCursor();}
});
document.addEventListener('mousemove',e=>{rememberCursor(e);if(flight&&document.pointerLockElement===canvas)lookFlight(e.movementX,e.movementY);});
document.addEventListener('pointerdown',rememberCursor,true);
document.documentElement.addEventListener('mouseleave',()=>{if(!document.pointerLockElement)cursorAnchor=null;});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{
 if(!camera||fatal||drag||pending)return;
 if(flight){
  canvas.focus();e.preventDefault();return;
 }
 canvas.focus();canvas.setPointerCapture(e.pointerId);e.preventDefault();
 lastClickPickedCoordinate=false;
 if(commandBar.picking()){
  if(e.button===0&&!e.shiftKey){
   lastClickPickedCoordinate=true;
   if(prefs.resource?.kind==='jar'&&!collisions&&!collisionError){note(collisionError??'正在读取原版方块形状，请稍候。',Boolean(collisionError));return;}
   drag={id:e.pointerId,commandPoint:true};return;
  }
  const nav=navigation(e);
  if(nav){drag={id:e.pointerId,nav,x:e.clientX,y:e.clientY,button:e.button,moved:false};canvas.classList.add('drag');}
  return;
 }
 if(e.button===0&&!e.shiftKey){
  const subject=entityGizmo(),handle=subject&&tryGizmo(e,subject);
  if(handle){
   drag={...handle,id:e.pointerId,nav:handle.tangent?'entityRotate':'entityMove',x:e.clientX,y:e.clientY,ox:e.clientX,oy:e.clientY,last:handle.tangent?ringAngle(e,handle):null,total:0,steps:0};
   canvas.classList.add('drag');dirty();return;
  }
  if(mode!=='view'&&prefs.resource?.kind==='jar'&&!collisions&&!collisionError){note(collisionError??'正在读取原版方块形状，请稍候。',Boolean(collisionError));return;}
  const entityPosition=!$('pane-entities').hidden&&entities.picking(),entity=entityPosition?null:targetEntity(e);
  if(entity||entityPosition){
   drag={id:e.pointerId,button:0,x:e.clientX,y:e.clientY,ox:e.clientX,oy:e.clientY,entity,entityPosition,entityEdit:true};return;
  }
 }
 const nav=navigation(e);
 if(!nav&&e.button!==0)return;
 const g=!nav&&e.button===0&&transformMode()&&(!blueprint||blueprint.origin)&&!(mode==='box'&&boxDraft())?tryGizmo(e):null;
 if(g?.tangent){drag={...g,id:e.pointerId,nav:'rotate',steps:0,total:0,last:ringAngle(e,g),x:e.clientX,y:e.clientY};canvas.classList.add('drag');dirty();return;}
 drag=g?{id:e.pointerId,nav:'gizmo',axis:g.axis,slope:g.slope,ox:e.clientX,oy:e.clientY,x:e.clientX,y:e.clientY,steps:0}:{id:e.pointerId,nav,x:e.clientX,y:e.clientY,button:e.button,moved:false};
 if(g){canvas.classList.add('drag');return;}
 if(!nav&&e.button===0&&mode==='box'&&!blueprint&&!pickingPivot&&!pending)drag.boxFrom=target(e);
 if(nav)canvas.classList.add('drag');else if(brushTools.has(mode))startBrush(e);
});
canvas.addEventListener('pointermove',e=>{
 if(!camera||fatal)return;
 commandCursor={clientX:e.clientX,clientY:e.clientY,altKey:e.altKey};
 if(flight){
  if(document.pointerLockElement!==canvas){
   const old=flight.aim;flight.aim=[e.clientX,e.clientY];if(old)lookFlight(e.clientX-old[0],e.clientY-old[1]);
  }
  return;
 }
 if(drag&&drag.id===e.pointerId){if(drag.commandPoint){dirty();return;}const x=drag.x,y=drag.y,dx=e.clientX-x,dy=e.clientY-y;drag.x=e.clientX;drag.y=e.clientY;drag.moved||=Math.abs(dx)+Math.abs(dy)>0;
  if(drag.entityEdit){
   if(drag.entityPosition||Math.hypot(e.clientX-drag.ox,e.clientY-drag.oy)<=6)return;
   drag.entity=null;
   if(mode!=='view'||prefs.navigation==='blender')return;
   drag.entityEdit=false;drag.nav='orbit';canvas.classList.remove('entity-hover');canvas.classList.add('drag');
  }
  if(drag.subject){
   const d=drag;
   if(d.nav==='entityRotate'){rotateDrag(e,d,dx,dy);d.steps=Math.round(d.total*180/Math.PI);}
   else d.steps=Math.round(dot([e.clientX-d.ox,e.clientY-d.oy],d.slope)/dot(d.slope,d.slope)*16)/16;
   const {pos,rotation}=entityTransformDraft(d);$('coords').textContent=pos?`实体位置：${pos.map(n=>+n.toFixed(4)).join(', ')}`:`朝向 ${rotation[0]}°`;
   dirty();return;
  }
  if(drag.nav==='rotate'){
   const d=drag;rotateDrag(e,d,dx,dy);const steps=Math.round(d.total/(Math.PI/2));
   if(steps!==d.steps){d.steps=steps;queueTransformPreview(d);}
   $('coords').textContent=`绕 ${'XYZ'[d.axis]} 轴：${d.steps*90}°`;dirty();return;
  }
  if(drag.nav==='gizmo'){
   const d=drag,v=[e.clientX-d.ox,e.clientY-d.oy],k=Math.round(dot(v,d.slope)/dot(d.slope,d.slope));const b=d.bounds??=selectionBounds();
   const steps=!b?0:blueprint?.origin?k:mode==='extrude'?clamp(k,-4095,4095):clamp(k,-b.lo[d.axis],model.size[d.axis]-1-b.hi[d.axis]);
   if(steps!==d.steps){d.steps=steps;queueTransformPreview(d);dirty();}return;
  }
  if(drag.nav==='orbit'){const sensitivity=.007*mouseSensitivityScale;camera.yaw-=dx*sensitivity;camera.pitch=clamp(camera.pitch+dy*sensitivity,-1.565,1.565);dirty();return;}
  if(drag.nav==='zoom'){zoom(dy*3);return;}
  if(drag.nav==='pan'){const {right,up}=pose(),k=2*camera.distance*Math.tan(fov/2)/canvas.clientHeight;camera.target=plus(camera.target,plus(times(right,-dx*k),times(up,dy*k)));dirty();return;}
  sweepBrush(e,x,y);
 }
 if(commandBar.picking()){dirty();return;}
 const entity=!drag?targetEntity(e):null;
 canvas.classList.toggle('entity-hover',Boolean(entity));
 if(entity){if(hover){hover=null;dirty();}$('coords').textContent=`${entity.id} · 单击选中实体`;return;}
 const p=entities.picking()?entityPositionAt(e):target(e);if(drag?.boxFrom&&p){drag.boxTo=p;dirty();}
 if(!same(hover,p)){hover=p;if(mode==='box')boxHint();dirty();}const s=p&&model.states[(value(p)>>1)-1];$('coords').textContent=p?`${coord(p)}${s?' · '+s.name:''}`:'—';
});
canvas.addEventListener('pointerup',e=>{
 if(flight)return;
 if(!drag||drag.id!==e.pointerId)return;const d=drag;drag=null;canvas.classList.remove('drag');
 if(d.commandPoint){
  commandCursor={clientX:e.clientX,clientY:e.clientY,altKey:e.altKey};
  const pos=commandPointAt(commandCursor);
  if(pos)commandBar.plot(pos);else{note('请选择结构范围内的坐标。',true);dirty();}
  return;
 }
 if(d.subject){if(d.steps)entities.transform(d.subject,entityTransformDraft(d));dirty();return;}
 if(d.nav==='rotate'||d.nav==='gizmo'){
  if(transformFrame){cancelAnimationFrame(transformFrame);transformFrame=0;previewBlockTransform(d);}
  const turn=d.nav==='rotate';sendTransform(d.axis,turn?d.steps%4:d.steps,turn?d:undefined);
  if(!pending)clearTransformPreview();dirty();return;
 }
 if(d.entityEdit){
  if(d.entityPosition){const p=entityPositionAt(e);if(p)entities.plot(plus(p,[.5,0,.5]));else note('请选择结构边界内的位置。',true);}
  else if(d.entity&&Math.hypot(e.clientX-d.ox,e.clientY-d.oy)<=6){showSidebar('entities');entities.choose(d.entity.index);}
  return;
 }
 if(d.nav||d.button!==0||!model||fatal)return;
 if(blueprint&&sampleReturn){clickModel(target(e));return;}
 if(blueprint&&!blueprint.origin){const t=trace(e,$('ignorePasteFluids').checked),p=t?.p?plus(t.p,t.n):workplane(t);if(!bounds(p)){note('请点击模板范围内可放置的一格。',true);return;}blueprint.origin=anchorOrigin(p,templateAnchor(blueprint.item.size,blueprint.anchor),blueprint.axes);vscode.postMessage({type:'previewTemplate',id:blueprint.item.id});selectionUI();dirty();return;}
 if(mode==='box'&&pickingPivot){const p=target(e)||workplane(trace(e));if(p){pivot=p.map(v=>v+.5);lastTurn=null;pickingPivot=false;selectionUI();dirty();}return;}
 if(blueprint?.origin)return;
 if(mode==='extrude'){chooseVoxel(target(e),e.ctrlKey||e.metaKey);return;}
 if(d.moved&&d.boxFrom&&d.boxTo&&!same(d.boxFrom,d.boxTo)){boxSelect(d.boxFrom,d.boxTo);return;}
 if(brushTools.has(mode)){sweepBrush(e,d.x,d.y);commitBrush(e);}
 else clickModel(target(e));
});
function cancelDrag(e){if(drag?.id!==e.pointerId)return;if(drag.nav==='rotate'||drag.nav==='gizmo')clearTransformPreview();drag=null;canvas.classList.remove('drag');if(!brush?.committing)clearBrush();dirty();}
canvas.addEventListener('dblclick',e=>{
 if(commandBar.picking()||lastClickPickedCoordinate)return;
 if(mode==='box'&&!flight&&!pickingPivot&&!blueprint&&!pending&&e.button===0){const p=target(e);if(selectableCell(p)){boxY=[0,0];boxSelect(p,p);}}
});
canvas.addEventListener('pointercancel',cancelDrag);
canvas.addEventListener('lostpointercapture',cancelDrag);
canvas.addEventListener('pointerleave',()=>{commandCursor=null;if(commandBar.picking())dirty();canvas.classList.remove('entity-hover');if(flight){flight.aim=null;return;}if(!drag){hover=null;if(mode==='box')boxHint();dirty();}});
function zoom(d){camera.distance=clamp(camera.distance*Math.exp(clamp(d,-240,240)*.0018),.65,Math.max(1024,Math.hypot(...model.size)*12));dirty();}
function navigation(e){
 if(prefs.navigation==='blender')return e.button===1?(e.shiftKey?'pan':e.ctrlKey?'zoom':'orbit'):null;
 if(e.button===2||e.button===1||e.shiftKey&&e.button===0)return 'pan';
 if(e.button===0&&!(mode==='box'&&(pickingPivot||blueprint&&!blueprint.origin))&&(mode==='view'||(['box','extrude','pick'].includes(mode)&&!sampleReturn&&!target(e)&&!(transformMode()&&tryGizmo(e)))))return 'orbit';
 return null;
}
canvas.addEventListener('wheel',e=>{
 if(!camera)return;e.preventDefault();
 if(flight){const delta=e.deltaMode?e.deltaY*(e.deltaMode===1?40:100):e.deltaY;flight.speed=clamp(flight.speed-delta/100,8,24);dirty();return;}
 if(!commandBar.picking()&&e.altKey&&transformMode()){
  if(pending||drag?.nav||blueprint)return;
  altRemainder+=e.deltaMode?Math.sign(e.deltaY)*40:e.deltaY;
  const steps=-Math.sign(Math.trunc(altRemainder/35));if(!steps)return;altRemainder=0;
  adjustRegionY(steps,e.shiftKey);return;
 }
 zoom(e.deltaY);
},{passive:false});

function runCommand(cmd){
 if(!model||fatal)return;
 if(cmd==='flyView'){setFlight(!flight,true);return;}
 if(flight)return;
 if(cmd==='clearSelection'&&commandBar.cancel())return;
 if(cmd==='clearSelection'&&drag?.subject){cancelDrag({pointerId:drag.id});return;}
 if(cmd==='clearSelection'&&entities.picking()){entities.stopPick();return;}
 if(Object.hasOwn(names,cmd)){setMode(cmd);canvas.focus();return;}
 const axis=/^axis([XYZ])(Plus|Minus)$/.exec(cmd);
 if(axis){if(transformMode())sendTransform('XYZ'.indexOf(axis[1]),axis[2]==='Plus'?1:-1);return;}
 if(cmd==='clearSelection'){if(blueprint&&sampleReturn){const prev=sampleReturn;sampleReturn=null;setMode(prev,true);drawOverwrite();return;}if(blueprint&&pending)return;if(blueprint){if(drag)cancelDrag({pointerId:drag.id});clearBlueprint();selectionUI();dirty();return;}if(drag?.nav==='rotate'||drag?.nav==='gizmo'){cancelDrag({pointerId:drag.id});return;}if(pickingPivot){pickingPivot=false;selectionUI();return;}if(brush&&!brush.committing){clearBrush();return;}$('deselect').click();return;}
 if(cmd==='settings'){openSettings();return;}
 if(['resize','paletteAdd','paletteDelete','topView','reset','material','invisibleBlocks','paletteState','tileSave','tileDelete','toggleMoveTile'].includes(cmd))$(cmd==='toggleMoveTile'?'moveTile':cmd).click();
}
function selectSidebar(page,focus=false){
 if(page==='entities'&&$('pane-entities').hidden&&!pending&&!flight&&!blueprint)setMode('view',true);
 showSidebar(page,focus);
}
for(const [i,b] of sidebarTabs.entries()){
 b.onclick=()=>selectSidebar(b.dataset.sidebar);
 b.onkeydown=e=>{
  let next;if(e.key==='Home')next=0;else if(e.key==='End')next=sidebarTabs.length-1;
  else if(e.key==='ArrowLeft'||e.key==='ArrowRight')next=(i+sidebarTabs.length+(e.key==='ArrowRight'?1:-1))%sidebarTabs.length;
  else return;
  e.preventDefault();selectSidebar(sidebarTabs[next].dataset.sidebar,true);
 };
}
$('startPick').onclick=()=>{setMode('pick');canvas.focus();};
for(const b of document.querySelectorAll('[data-tool]'))b.onclick=()=>{setMode(b.dataset.tool);canvas.focus();};
$('save').onclick=()=>vscode.postMessage({type:'save'});
$('undo').onclick=()=>undoEdit(false);$('redo').onclick=()=>undoEdit(true);
$('invisibleBlocks').onclick=()=>{
 showInvisible=!showInvisible;$('invisibleBlocks').setAttribute('aria-pressed',String(showInvisible));
 $('invisibleBlocks').textContent=showInvisible?'隐藏隐形方块':'显示隐形方块';
 if(!showInvisible){clearMarkers();updateInvisibleHint();}
 if(model){
  worker.postMessage({type:'invisible',model:modelId,show:showInvisible});
  if(mode==='view'&&viewOverlay?.mode==='box')viewOverlay.region=selectionRegion??selectionBounds();
  selectionUI();
 }dirty();
};
$('structureBounds').onclick=()=>{showStructureBounds=!showStructureBounds;$('structureBounds').setAttribute('aria-pressed',String(showStructureBounds));dirty();};
$('flyView').onclick=()=>setFlight(!flight,true);$('topView').onclick=()=>reset(true);$('reset').onclick=()=>reset();$('palette').onchange=()=>vscode.postMessage({type:'palette',palette:+$('palette').value});
$('filter').oninput=()=>{$('swatches').scrollTop=0;drawPalette();};$('layer').onchange=()=>layerSet($('layer').value);$('layerRange').oninput=()=>requestLayer($('layerRange').value);$('layerMode').onchange=()=>layerSet($('layer').value);
for(const id of ['cornerA','cornerB'])$(id).oninput=()=>{boxHint();selectionUI();dirty();};
$('confirmBox').onclick=()=>{const a=corner('cornerA'),b=corner('cornerB');if(a&&b&&!pending)boxSelect(a,b);};
$('apply').onclick=fillSelection;
for(const b of $('steps').querySelectorAll('button'))b.onclick=()=>sendTransform(+b.dataset.axis,+b.dataset.step);
$('pickPivot').onclick=()=>{if(!pending){pickingPivot=!pickingPivot;selectionUI();canvas.focus();}};
$('resetPivot').onclick=()=>{pivot=lastTurn=null;pickingPivot=false;selectionUI();dirty();};
for(const b of document.querySelectorAll('[data-turn]'))b.onclick=()=>{const sel=selectionBounds(),a=Number(b.dataset.turn);if(mode==='box'&&sel&&!pickingPivot&&!drag)sendTransform(a,Number(b.dataset.spin),{axis:a,pivot:rotationPivot(a,sel.center)});};
$('boxIncludeEntities').onchange=()=>{captureBoxEntities(boxDraft()?null:selectionRegion??selectionBounds());selectionUI();dirty();};
$('copyTemplate').onclick=copyTemplate;$('confirmPaste').onclick=commitBlueprint;
$('ignorePasteFluids').onchange=()=>{void meshBlueprint(true);canvas.focus();};
$('placeTemplateEntities').onchange=()=>{vscode.setState?.({...vscode.getState?.(),placeTemplateEntities:$('placeTemplateEntities').checked});void meshBlueprint(true);dirty();};
$('pasteOverwriteSettings').onclick=()=>{showSidebar('tools');$('moveOverwrite').focus();};
$('cancelPaste').onclick=()=>{if(!pending){clearBlueprint();selectionUI();canvas.focus();}};
$('deselect').onclick=()=>{if(blueprint){if(pending)return;clearBlueprint();}pivot=lastTurn=null;pickingPivot=false;selection.clear();selectionRegion=null;boxEntities=[];setCorners(null);};
$('keyboard').onclick=openSettings;
$('resize').onclick=openSize;$('cancelSize').onclick=()=>$('sizeDialog').close();
$('sizeForm').onsubmit=e=>{e.preventDefault();const size=['X','Y','Z'].map(k=>Number($('size'+k).value));$('sizeDialog').close();requestLayout({kind:'size',size});};
$('paletteAdd').onclick=()=>requestLayout({kind:'paletteAdd'});
$('paletteDelete').onclick=()=>requestLayout({kind:'paletteDelete'});
$('paletteClean').onclick=()=>requestLayout({kind:'paletteClean'});
$('paletteState').onclick=()=>{try{if(active>=0)requestLayout({kind:'paletteState',stateId:active,state:readState()});}catch(e){note(e.message,true);}};
$('tilePath').oninput=drawTilePaths;$('tilePath').onchange=tileField;$('tilePath').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();tileField();$('tileValue').focus();}};
$('tileSave').onclick=()=>applyTile(false);$('tileDelete').onclick=()=>applyTile(true);
$('initTile').onclick=()=>{if(inspectCell===null||pending||fatal||flight||$('missingEntity').hidden)return;pending=true;updateDraft();note('');vscode.postMessage({type:'edit',edit:{tool:'tileInit',cell:inspectCell}});};
function currentState(){return inspectCell===null?null:model?.states[(cells[inspectCell]>>1)-1]??null;}
function propertySchema(st){return {...Object.fromEntries(Object.entries(st.props).map(([k,v])=>[k,{values:[v]}])),...blockSchema[st.name]};}
function refreshBlockState(reset=false){
 const st=currentState();$('stateEditor').hidden=$('entityPanel').hidden=!st;$('inspectEmpty').hidden=Boolean(st);
 inspector.state(st,st?propertySchema(st):{},reset);if(!st)return;
 $('stateSummary').textContent=`${coord(positionOf(inspectCell))} · ${st.name}`;
}
function submitInspector(tool,fields){
 if(inspectCell===null||pending||fatal||flight)return;
 pending=true;inspectorPending=tool;updateDraft();note('');
 vscode.postMessage({type:'edit',edit:{tool,cell:inspectCell,expected:(cells[inspectCell]>>1)-1,...fields}});
}
const inspectorLocked=()=>pending||fatal||Boolean(flight);
const inspector=createStateInspector({blocked:inspectorLocked,writeState:edits=>submitInspector('state',{edits})});
const tileTree=createNbtTree({prefix:'tile',scope:'blockEntity',schema:nbtSchema,blocked:inspectorLocked,hints,
 apply:(fields,data)=>submitInspector('tile',{fields,revision:data.revision})});
function effectiveKeys(){const a={...defaults},{select,fill,...custom}=prefs.keys||{};
 if(!Object.hasOwn(custom,'box')&&(select||fill))custom.box=select||fill;
 for(const [action,key] of Object.entries(custom)){if(!Object.hasOwn(actions,action))continue;if(key)for(const k of Object.keys(a))if(k!==action&&a[k]===key)a[k]=null;a[action]=key;}
 return a;
}
const navHelp={blender:'中键旋转 · Shift+中键平移 · Ctrl+中键或滚轮缩放',blockbench:'左键拖空白处旋转（查看模式可直接拖）· 右键或中键平移 · 滚轮缩放'};
function drawOverwrite(){
 const list=$('allowList');list.replaceChildren();$('allowCount').textContent=overwriteIds.size?`（${overwriteIds.size}）`:'';
 for(const id of overwriteIds){const row=document.createElement('li'),text=document.createElement('code'),btn=document.createElement('button');text.textContent=id;btn.textContent='移除';btn.setAttribute('aria-label','移除 '+id);
  btn.onclick=()=>{overwriteIds.delete(id);storeOverwrite();};row.append(text,btn);list.append(row);}
 $('allowPick').setAttribute('aria-pressed',String(Boolean(sampleReturn)));$('allowPick').textContent=sampleReturn?'取消取样添加':'用取样添加';
}
function storeOverwrite(){vscode.setState?.({...vscode.getState?.(),overwriteIds:[...overwriteIds]});drawOverwrite();}
function addOverwrite(raw){const t=raw.trim().toLowerCase(),id=t.includes(':')?t:'minecraft:'+t;if(!t||id.length>160||!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)){note('请输入有效方块 ID，例如 minecraft:stone。',true);return;}
 if(!overwriteIds.has(id)&&overwriteIds.size>=256){note('白名单最多 256 个方块。',true);return;}
 overwriteIds.add(id);$('allowBlock').value='';storeOverwrite();note('已加入移动覆盖白名单：'+id);
}
$('allowAdd').onclick=()=>addOverwrite($('allowBlock').value);
$('allowBlock').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addOverwrite(e.currentTarget.value);}};
$('allowPick').onclick=()=>{if(!model)return;
 if(sampleReturn){const prev=sampleReturn;sampleReturn=null;setMode(prev,true);}else{sampleReturn=mode;setMode('pick');note('点击要加入白名单的目标方块。');}
 drawOverwrite();canvas.focus();
};
$('navigationPreset').onchange=e=>{const preset=e.currentTarget.value;prefs={...prefs,navigation:preset};drawSettings();vscode.postMessage({type:'navigation',preset});};
function canUseGameRender(){return prefs.resource?.kind==='jar'&&Boolean(materials);}
function syncRenderPreference(){
 const on=canUseGameRender()&&prefs.rendering?.mode==='game',changed=gameRender!==on;
 gameRender=on;renderGamma=clamp(prefs.rendering?.gamma??.5,0,1);
 if(changed&&model&&worker){
  epoch++;renderOver=false;busy=true;status();worker.postMessage({type:'lighting',model:modelId,epoch,game:on});void meshBlueprint();
 }
 dirty();
}
function storeRendering(){
 const mode=$('renderMode').value,gamma=$('gameGamma').valueAsNumber;if(mode==='game'&&!canUseGameRender())return;
 prefs={...prefs,rendering:{mode,gamma}};syncRenderPreference();drawRendering();vscode.postMessage({type:'rendering',mode,gamma});
}
function drawRendering(){
 $('renderMode').querySelector('option[value="game"]').disabled=!canUseGameRender();$('renderMode').value=gameRender?'game':'smooth';
 $('gameGamma').disabled=!gameRender;$('gameGamma').value=renderGamma;$('gameGammaValue').textContent=renderGamma.toFixed(2);
 $('renderHint').textContent=canUseGameRender()?'游戏风格增加方块接缝的阴影。Gamma 越高越亮，只影响预览。':'选择客户端 JAR 后可使用游戏风格。';
}
$('renderMode').onchange=storeRendering;$('gameGamma').onchange=storeRendering;
$('gameGamma').oninput=e=>{if(!gameRender)return;renderGamma=e.target.valueAsNumber;$('gameGammaValue').textContent=renderGamma.toFixed(2);dirty();};
function updateInvisibleHint(){
 const toggle=$('invisibleBlocks'),key=effectiveKeys().invisibleBlocks;
 toggle.title=(key?`${key} · `:'')+toggle.dataset.legend+(markerMesh?.sampled?'\n结构过大，部分标记抽样显示。可切层查看。':'');
 if(key)toggle.setAttribute('aria-keyshortcuts',key.replace(/^Ctrl\+/,'Control+'));else toggle.removeAttribute('aria-keyshortcuts');
}
function drawSettings(){
 drawRendering();updateInvisibleHint();
 const preset=prefs.navigation==='blender'?'blender':'blockbench';$('navigationPreset').value=preset;
 $('navigationHint').textContent=navHelp[preset];$('help').textContent=navHelp[preset]+' · Alt+滚轮调整选框 Y';
 const r=prefs.resource;
 $('resourcePath').textContent=r?.kind==='jar'&&r.path?r.path:'色块模式（未使用外部资源）';
 const list=$('keysList'),keys=effectiveKeys();list.replaceChildren();
 for(const [a,title] of Object.entries(actions)){
  const label=document.createElement('span'),b=document.createElement('button'),clear=document.createElement('button');label.textContent=title;
  b.textContent=a===recording?'按下新键…':keys[a]||'未绑定';b.classList.toggle('keyRecording',a===recording);
  b.onclick=()=>{recording=a;drawSettings();};clear.textContent='清除';clear.disabled=!keys[a];clear.onclick=()=>{recording=null;vscode.postMessage({type:'shortcut',action:a,key:null});};list.append(label,b,clear);
 }
}
function openSettings(){recording=null;drawSettings();if(!$('settingsDialog').open)$('settingsDialog').showModal();}
$('materialLater').onclick=()=>$('materialIntro').close();
$('materialIntro').onclose=()=>{if(!prefs.materialIntroSeen)vscode.postMessage({type:'dismissMaterialIntro'});};
$('settingsClose').onclick=()=>$('settingsDialog').close();$('settingsDialog').onclose=()=>{recording=null;};
$('resetKeys').onclick=()=>{recording=null;vscode.postMessage({type:'resetKeys'});};
for(const b of document.querySelectorAll('[data-resource],[data-intro-resource]'))b.onclick=()=>vscode.postMessage({type:'resource',kind:b.dataset.resource??b.dataset.introResource});
function setCommandAlt(on){
 if(commandCursor&&commandCursor.altKey!==on){commandCursor.altKey=on;if(commandBar.picking())dirty();}
}
window.addEventListener('keyup',e=>{if(e.key==='Alt')setCommandAlt(e.altKey);heldKeys.delete(e.code);if(!heldKeys.size&&flight)flight.last=null;},true);
canvas.addEventListener('blur',clearFlightKeys);
window.addEventListener('blur',()=>{clearFlightKeys();setCommandAlt(false);});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearFlightKeys();});
window.addEventListener('keydown',e=>{
 if(e.key==='Alt'){
  setCommandAlt(e.altKey);
  if(commandBar.picking()){e.preventDefault();return;}
 }
 if(e.key==='Escape'&&e.target===canvas&&commandBar.cancel()){e.preventDefault();e.stopPropagation();return;}
 if(recording&&$('settingsDialog').open){const key=keyFrom(e);if(key){const action=recording;recording=null;e.preventDefault();e.stopImmediatePropagation();vscode.postMessage({type:'shortcut',action,key});drawSettings();}return;}
 if(flight){
  if(e.isComposing||e.key==='Tab')return;
  e.preventDefault();e.stopImmediatePropagation();
  if(e.key==='Escape'){setFlight(false,true);return;}
  if(e.key==='/'&&!e.ctrlKey&&!e.altKey&&!e.metaKey){setFlight(false,true);commandBar.focus();return;}
  if(e.target===canvas&&flightKeys.has(e.code)&&!e.ctrlKey&&!e.altKey&&!e.metaKey){
   if(!e.repeat){if(!heldKeys.size)flight.last=performance.now();heldKeys.add(e.code);dirty();}return;
  }
  if(!e.repeat&&keyFrom(e)===effectiveKeys().flyView)setFlight(false,true);
  return;
 }
 if(e.repeat||e.isComposing||$('settingsDialog').open||$('sizeDialog').open||$('materialIntro').open||$('snbtDialog').open||e.target.closest?.('input,textarea,select,[contenteditable],[role=tab],#brushPreset,#brushPresetMenu,#sidebarSplitter'))return;
 if(!flight&&!e.altKey&&!e.shiftKey&&(e.ctrlKey||e.metaKey)){
  if(e.key.toLowerCase()==='c'&&!$('pane-entities').hidden&&!$('entityCopy').disabled&&!blueprint){e.preventDefault();e.stopPropagation();$('entityCopy').click();return;}
  if(e.key.toLowerCase()==='c'&&(selection.size||selectionRegion)&&!blueprint){e.preventDefault();e.stopPropagation();copyTemplate();return;}
  if(e.key.toLowerCase()==='v'&&templates.length){e.preventDefault();e.stopPropagation();startBlueprint(templates[0]);return;}
 }
 if(e.key==='/'&&e.target===canvas&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!blueprint){e.preventDefault();commandBar.focus();return;}
 if(blueprint&&!e.altKey&&(e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();e.stopImmediatePropagation();undoEdit(e.shiftKey||e.key.toLowerCase()==='y');return;}
 if(blueprint&&e.key==='Escape'){e.preventDefault();e.stopPropagation();runCommand('clearSelection');return;}
 if(blueprint&&e.key==='Enter'&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&e.target===canvas){e.preventDefault();commitBlueprint();return;}
 if(e.key==='Tab'&&e.target!==canvas)return;
 const key=keyFrom(e),a=Object.entries(effectiveKeys()).find(([,v])=>v&&v===key)?.[0];if(a){e.preventDefault();e.stopPropagation();runCommand(a);}
},true);
new ResizeObserver(dirty).observe(canvas);
try{
 scene=createSceneRenderer(gl);
 thumbnails=new Thumbnails(gl,bind,scene.uniforms.vp);
 thumbnailObserver=new IntersectionObserver(entries=>{for(const {target,isIntersecting} of entries)if(isIntersecting&&target.isConnected){
  thumbnailObserver.unobserve(target);const i=Number(target.dataset.state),s=model?.states[i];if(s)thumbnails.show(target,s,swatches[i],textureOn?materials:null);
 }},{root:$('swatches'),rootMargin:'44px'});
 setMode('view');drawSettings();drawOverwrite();updateDraft();
 const root=document.body.dataset.assets;if(root&&root!=='__ASSETS__'){materials=new Materials(gl,root,dirty);textureOn=true;}
 $('material').classList.toggle('needs-assets',!materials);
 if(!materials){$('material').textContent='导入材质…';$('material').title='选择 Minecraft 客户端 JAR';}
 $('material').onclick=()=>{if(!materials){$('materialIntro').showModal();return;}textureOn=!textureOn;applyMaterials();};
 // Optional local compact swatches. Never contact a texture service or CDN.
 const href=new URL('./colors.json',import.meta.url);
 const [code,colors,schema,nbt,types]=await Promise.all([fetch(document.body.dataset.worker).then(r=>{if(!r.ok)throw new Error('找不到网格工作线程');return r.text();}),fetch(href).then(r=>r.ok?r.json():{}).catch(()=>({})),fetch(new URL('./state-schema.json',import.meta.url)).then(r=>r.ok?r.json():{}).catch(()=>({})),fetch(new URL('./nbt-catalog.json',import.meta.url)).then(r=>r.ok?r.json():null).catch(()=>null),fetch(new URL('./block-entities.json',import.meta.url)).then(r=>r.ok?r.json():{}).catch(()=>({}))]);
 catalog=colors;blockSchema=schema;nbtCatalog=nbt;tileTypes=types;registryBlocks=Object.keys(schema);mountBrushPicker();
 const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);
 worker.onmessage=({data:m})=>{
  if(m.type==='templateThumb'){
   const done=templateRenders.get(m.id);templateRenders.delete(m.id);
   if(done)done(!fatal&&templateImages.has(m.id)?thumbnails.enqueue({vertices:m.vertices,texture:materials.texture}):null);
   return;
  }
  if(m.model!==modelId||fatal)return;
  if(m.type==='invisibleMesh'){
   if(!showInvisible||m.mode!==slice||(slice!=='full'&&m.layer!==layer))return;
   clearMarkers();const {vertices}=m;
   if(vertices.length){const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);markerMesh={buffer,count:vertices.length/8,sampled:m.sampled};}
   updateInvisibleHint();dirty();return;
  }
  if(m.type==='blueprintMesh'){
   if(!blueprint||m.run!==blueprintRun)return;
   const buffer=blueprintBuffer?.buffer??gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,m.vertices,gl.STATIC_DRAW);
   blueprintBuffer={buffer,count:m.vertices.length/8};templateButtons();dirty();return;
  }
  if(m.epoch!==epoch)return;for(const {key,mesh,alpha} of m.output)if(meshes.replace(key,mesh,alpha))renderOver=true;if(busy){busy=m.remaining>0;status();if(!busy){if(renderOver)note('模型的可见面过多。用切层减少同时预览的范围。',true);else if($('message').textContent==='正在生成预览…')note('');}}dirty();};
 worker.onerror=e=>{fatal=true;note(e.message||'预览工作线程异常，请重新打开文件。',true);updateDraft();};
 vscode.postMessage({type:'ready'});
}catch(e){fatal=true;note(e.message,true);updateDraft();}
