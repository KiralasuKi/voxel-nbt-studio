'use strict';
const {serveWebview,launchBrowser}=require('./webview-harness.cjs');
const {readFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
const {Structure,create,clipThumb}=require('../lib/nbt');
const real=process.argv[2];
const assets=process.env.VOXEL_ASSETS;let pngs=0;const texturePaths=new Set();
(async()=>{
 const {compileMask,maskAir}=await import('../media/mask.js');
 const maskJar=process.env.VOXEL_MASK_JAR,maskCatalog=maskJar?{...await require('../lib/assets').jarMaskData(maskJar),traits:require('../media/mask-states.json')}:null;
 const collisions=maskJar?await require('../lib/native-summon').collisionShapes(maskJar):null;
 const server=await serveWebview({assets,onAsset:p=>{if(p.endsWith('.png')){pngs++;texturePaths.add(p);}}});
 let browser;
 try{
  browser=await launchBrowser();
  const page=await browser.newPage({viewport:{width:1190,height:740}}),errs=[];page.on('pageerror',e=>errs.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errs.push(m.text());});
  let doc=await Structure.open(create([16,13,18]));doc.edit({tool:'fill',box:[[3,0,4],[11,1,11]],state:{name:'minecraft:smooth_quartz',props:{}}});doc.edit({tool:'fill',box:[[3,2,4],[7,6,7]],state:{name:'minecraft:bricks',props:{}}});
  const traces=[]; let prefs={keys:{},materialIntroSeen:true};const clips=new Map();
  const load=async()=>page.evaluate(data=>window.postMessage({type:'model',data},'*'),doc.snapshot());
  await page.exposeFunction('bridge',async m=>{
   traces.push(m);
   if(m.type==='ready')await load();
   if(m.type==='upgradeStructure')await page.evaluate(()=>window.postMessage({type:'ack'},'*'));
   if(m.type==='copyTemplate'){
    const clip=doc.copySelection(m.selection,0,m.includeInvisible,m.region,m.entitySelection??[]);clips.set(clips.size+1,clip);const items=[...clips].reverse().map(([id,c])=>({id,name:'模板 '+id,entityCount:c.entities.length,...clipThumb(c)}));
    await page.evaluate(items=>{window.postMessage({type:'templates',items},'*');window.postMessage({type:'copied'},'*');},items);
   }
   if(m.type==='previewTemplate')await page.evaluate(v=>window.postMessage(v,'*'),{type:'previewTemplate',id:m.id,states:clips.get(m.id).states,blocks:clips.get(m.id).blocks.map(b=>[...b.pos,b.id])});

   if(m.type==='layout'){try{const q={...m.layout,palette:0};
    if(q.kind==='entity'&&q.action==='add'){
     if(maskJar)q.summoned=(await require('../lib/native-summon').summonEntity(maskJar,q.id,q.pos,q.snbt)).nbt;
     else{const id=Buffer.from(q.id);q.summoned=Buffer.concat([Buffer.from([10,0,0,8,0,2,105,100,0,id.length]),id,Buffer.from([0])]);}
    }
    const layout=doc.layout(q);if(layout){doc=await Structure.open(layout.raw);if(m.layout.kind==='entity')await page.evaluate(data=>window.postMessage({type:'entityRows',data},'*'),{entities:doc.entities,entityList:doc.entityList()});else await load();}await page.evaluate(({removed,entity,commandText})=>window.postMessage({type:'ack',commandText,entity,notice:removed?'已清除 '+removed+' 个未使用状态槽位。':null},'*'),{removed:layout?.removed,entity:layout?.entity,commandText:m.commandText});}catch(e){await page.evaluate(message=>window.postMessage({type:'error',message},'*'),e.message);}}
   if(m.type==='shortcut'){prefs.keys[m.action]=m.key;await page.evaluate(v=>window.postMessage({type:'prefs',prefs:v},'*'),prefs);}
   if(m.type==='rendering'){prefs.rendering={mode:m.mode,gamma:m.gamma};await page.evaluate(v=>window.postMessage({type:'prefs',prefs:v},'*'),prefs);}
   if(m.type==='navigation'){prefs.navigation=m.preset;await page.evaluate(v=>window.postMessage({type:'prefs',prefs:v},'*'),prefs);}
   if(m.type==='snbt')await page.evaluate(data=>window.postMessage({type:'snbt',...data},'*'),doc.snbt());
   if(m.type==='entityDetails')await page.evaluate(data=>window.postMessage({type:'entityDetails',data},'*'),doc.entityDetails(m.index));
   if(m.type==='inspect'||m.type==='tileValue'){const data=m.type==='inspect'?doc.tileInfo(m.cell):doc.tileValue(m.cell,m.path);await page.evaluate(packet=>window.postMessage(packet,'*'),{type:m.type,data,cell:m.cell,path:m.path});}
   if(m.type==='edit'){try{const q=m.edit,spec=q.blockFilter?.tag?{type:'matching_blocks',blocks:'#'+q.blockFilter.name}:q.mask,rule=spec&&compileMask(spec,maskCatalog);const a=q.tool==='paste'?doc.paste(clips.get(q.template),q.origin,q.axes,q):doc.edit(q,rule?(d,c,p)=>rule.test((x,y,z)=>x<0||y<0||z<0||d.size.some((length,i)=>[x,y,z][i]>=length)?maskAir:d.state((d.at(d.cell([x,y,z]))>>1)-1,p)||maskAir,d.size[1],...d.pos(c)):undefined);await page.evaluate(a=>{window.postMessage({type:'patch',data:a.data,added:a.added,entityRows:a.entityRows,entitySelection:a.entitySelection},'*');window.postMessage({type:'ack',commandText:a.commandText,selection:a.selection,pasted:a.pasted},'*');},{...a,commandText:m.commandText,pasted:q.tool==='paste',entityRows:a.entityChanges?.length?{entities:doc.entities,entityList:doc.entityList()}:undefined,entitySelection:q.entitySelection?.map(r=>r.index)});}catch(e){await page.evaluate(message=>window.postMessage({type:'error',message},'*'),e.message);}}
  });
  await page.addInitScript(disablePointerLock=>{
   if(disablePointerLock)HTMLCanvasElement.prototype.requestPointerLock=undefined;
   window.acquireVsCodeApi=()=>({postMessage:m=>window.bridge(m),getState:()=>JSON.parse(sessionStorage.getItem('voxelState')||'{}'),setState:data=>sessionStorage.setItem('voxelState',JSON.stringify(data))});
   const send=Worker.prototype.postMessage,watched=new WeakSet();
   Worker.prototype.postMessage=function(message,...rest){
    if(message.type==='model'&&!watched.has(this)){
     watched.add(this);this.addEventListener('message',({data})=>{
      const q=window.watchTransform;if(!q||data.type!=='meshes')return;
      const {mesh}=data.output.find(m=>m.key===q.chunk)??{};if(!mesh)return;
      const [x,y,z]=q.pos;let from=false,to=false;
      for(let i=0;i<mesh.length;i+=24){
       const cx=(mesh[i]+mesh[i+8]+mesh[i+16])/3,cz=(mesh[i+2]+mesh[i+10]+mesh[i+18])/3;
       const normalY=(mesh[i+10]-mesh[i+2])*(mesh[i+16]-mesh[i])-(mesh[i+8]-mesh[i])*(mesh[i+18]-mesh[i+2]);
       if(cx<=x||cx>=x+1||cz<=z||cz>=z+1||normalY<=0)continue;
       if(mesh[i+1]===y+1&&mesh[i+9]===y+1&&mesh[i+17]===y+1)from=true;
       if(mesh[i+1]===y+2&&mesh[i+9]===y+2&&mesh[i+17]===y+2)to=true;
      }
      window.transformMesh={from,to};
     });
    }
    return send.call(this,message,...rest);
   };
   const gl=WebGLRenderingContext.prototype,draw=gl.drawArrays,matrix=gl.uniformMatrix4fv;
   const upload=gl.texSubImage2D;window.textureUploadSizes=[];
   gl.texSubImage2D=function(...args){const image=args[6];if(image instanceof HTMLCanvasElement)window.textureUploadSizes.push(image.width);return upload.apply(this,args);};
   const uniform1f=gl.uniform1f,uniformLocation=gl.getUniformLocation,bufferData=gl.bufferData,buffers=new WeakMap(),uniformNames=new WeakMap();
   gl.getUniformLocation=function(program,name){const loc=uniformLocation.call(this,program,name);if(loc)uniformNames.set(loc,name);return loc;};
   gl.uniform1f=function(location,value){const name=uniformNames.get(location);if(name==='opacity')this._opacity=value;if(name==='sceneGamma')this._sceneGamma=value;return uniform1f.call(this,location,value);};
   gl.bufferData=function(target,data,usage){
    if(window.watchCoordinateOutline&&usage===this.STREAM_DRAW&&data instanceof Float32Array){
     for(let i=3;i<data.length;i+=8)if(Math.abs(data[i]-.27)<.001&&data[i+1]===1&&Math.abs(data[i+2]-.39)<.001){window.coordinateOutlines=(window.coordinateOutlines??0)+1;break;}
    }
    if(window.captureBounds&&usage===this.STREAM_DRAW&&data?.length===576){
     const colors=[0,0,0,0];for(let i=3;i<data.length;i+=48){
      const r=data[i],g=data[i+1],b=data[i+2];colors[r>g+.2&&r>b+.2?0:g>r+.2&&g>b+.2?1:b>r+.2&&b>g+.2?2:3]++;
     }window.boundStrokeColors=colors;
    }
    if(target===this.ARRAY_BUFFER&&data instanceof Float32Array&&usage===this.STATIC_DRAW&&data.length%8===0){
    const buffer=this.getParameter(this.ARRAY_BUFFER_BINDING);if(buffer)buffers.set(buffer,data.some((n,i)=>i%8===6&&n>=0));
   }return bufferData.call(this,target,data,usage);};
   gl.uniformMatrix4fv=function(location,transpose,data){if(!this.getParameter(this.FRAMEBUFFER_BINDING)){this._screenStroke=data[0]===1&&data[5]===1&&data[10]===1&&data[15]===1;if(!this._screenStroke)window.cameraMatrix=Array.from(data);}return matrix.call(this,location,transpose,data);};
   gl.drawArrays=function(mode,start,count){const result=draw.call(this,mode,start,count);if(!this.getParameter(this.FRAMEBUFFER_BINDING)){
    if(this._opacity===.5&&!this._screenStroke&&mode===this.TRIANGLES&&count){window.blueprintTextured=buffers.get(this.getParameter(this.ARRAY_BUFFER_BINDING));window.blueprintDrawMode=document.querySelector('#mode').textContent;}
    if(window.axisSample&&mode===this.TRIANGLES&&this._screenStroke){
     const [x,y]=window.axisSample,r=this.canvas.getBoundingClientRect(),w=this.drawingBufferWidth,h=this.drawingBufferHeight;
     const rgba=new Uint8Array(9*4);this.readPixels(Math.floor((x-r.left)*w/r.width)-4,Math.floor((r.bottom-y)*h/r.height),9,1,this.RGBA,this.UNSIGNED_BYTE,rgba);
     let width=0;for(let i=0;i<rgba.length;i+=4)if(rgba[i+1]>170&&rgba[i+1]>rgba[i]+55&&rgba[i+1]>rgba[i+2]+55)width++;
     window.axisWidth=Math.max(window.axisWidth||0,width);
    }
    if(window.captureMarkers&&mode===this.LINES&&!this._screenStroke&&count>=120)window.markerDraw=count;
    if(window.captureBounds&&mode===this.TRIANGLES&&this._screenStroke&&count===72){
     const w=this.drawingBufferWidth,h=this.drawingBufferHeight,rgba=new Uint8Array(w*h*4);this.readPixels(0,0,w,h,this.RGBA,this.UNSIGNED_BYTE,rgba);
     const colors=[0,0,0];for(let i=0;i<rgba.length;i+=4){
      const r=rgba[i],g=rgba[i+1],b=rgba[i+2];
      if(r>65&&r>g+12&&r>b+12)colors[0]++;
      else if(g>65&&g>r+12&&g>b+12)colors[1]++;
      else if(b>65&&b>r+12&&b>g+12)colors[2]++;
     }
     window.boundColors=colors;window.boundPixels=colors.reduce((a,b)=>a+b,0);window.boundAlpha=this._opacity;
     window.boundBlend=this.isEnabled(this.BLEND);window.boundDepth=this.isEnabled(this.DEPTH_TEST);
     window.boundDepthWrite=this.getParameter(this.DEPTH_WRITEMASK);window.captureBounds=false;
    }
    if(window.captureLight&&mode===this.TRIANGLES&&!this._screenStroke&&count&&this._opacity===1){
     const rgba=new Uint8Array(4);this.readPixels(this.drawingBufferWidth>>1,this.drawingBufferHeight>>1,1,1,this.RGBA,this.UNSIGNED_BYTE,rgba);
     window.lightSample={gamma:this._sceneGamma,value:rgba[0]+rgba[1]+rgba[2]};window.captureLight=false;
    }
    if(window.captureSelection&&mode===this.TRIANGLES&&this._screenStroke&&count===144){
     const w=this.drawingBufferWidth,h=this.drawingBufferHeight,rgba=new Uint8Array(w*h*4);
     this.readPixels(0,0,w,h,this.RGBA,this.UNSIGNED_BYTE,rgba);
     let pixels=0,lo=w,hi=-1;for(let i=0;i<rgba.length;i+=4)if(rgba[i]<125&&rgba[i+1]>230&&rgba[i+2]>245){const x=(i/4)%w;pixels++;lo=Math.min(lo,x);hi=Math.max(hi,x);}
     window.selectionPixels=pixels;window.selectionWidth=hi-lo+1;window.selectionVertices=count;window.selectionDepthTest=this.isEnabled(this.DEPTH_TEST);window.captureSelection=false;
    }
   }return result;};
  },Boolean(process.env.VOXEL_NO_POINTER_LOCK));
  await page.goto('http://127.0.0.1:'+server.address().port);
  const rendered=async()=>page.waitForFunction(()=>!!document.getElementById('stats').textContent&&!document.getElementById('message').textContent&&!document.getElementById('stats').textContent.includes('构建'));
  await rendered();
  await page.locator('#upgradeStructure').click();
  assert.equal(traces.filter(m=>m.type==='upgradeStructure').length,1);
  await page.waitForFunction(()=>!document.getElementById('upgradeStructure').disabled);
  await page.locator('#keyboard').click();
  assert.deepEqual(await page.locator('[data-resource]').evaluateAll(buttons=>buttons.map(b=>b.dataset.resource)),['jar','download','none']);
  assert.match(await page.locator('#resourcePath').textContent(),/色块模式/);
  assert.equal(await page.locator('#renderMode option[value=game]').isDisabled(),true);assert.equal(await page.locator('#gameGamma').isDisabled(),true);
  await page.locator('#settingsClose').click();
  if(assets){await page.waitForFunction(()=>document.querySelector('#material').title.includes('2/2'));assert.ok(pngs>=2);await rendered();}assert.match(await page.locator('#dimensions').textContent(),/16 × 13 × 18/);
  await page.locator('[data-tool=box]').click();await page.locator('#cornerA').fill('2,1,2');await page.locator('#cornerB').fill('4,1,3');await page.locator('#name').fill('minecraft:amethyst_block');await page.locator('#apply').click();
  await page.waitForFunction(()=>document.getElementById('stats').textContent.includes('250 可见方块'));
  assert.equal(doc.state((doc.at(doc.cell([2,1,2]))>>1)-1).name,'minecraft:amethyst_block');
  await page.locator('#layerMode').selectOption('single');await page.locator('#layer').fill('1');await page.locator('#layer').press('Tab');await page.waitForTimeout(180);await rendered();
  await page.locator('#topView').click();await page.locator('[data-tool=pick]').click();const canvas=await page.locator('#scene').boundingBox();await page.mouse.click(canvas.x+canvas.width*.5+4,canvas.y+canvas.height*.5+4);assert.match(await page.locator('#inspect').textContent(),/smooth_quartz/);
  await page.locator('[data-tool=box]').click();await page.mouse.dblclick(canvas.x+canvas.width*.5+4,canvas.y+canvas.height*.5+4);assert.match(await page.locator('#selectionTitle').textContent(),/1 格/);
  const selected=(await page.locator('#inspect').textContent()).match(/^(\d+), (\d+), (\d+)/).slice(1).map(Number);
  await page.locator('#reset').click();await page.waitForTimeout(70);
  const dist=Math.hypot(16,13,18)*1.07,yaw=.7,pitch=.47,c=Math.cos(pitch);
  const back=[Math.sin(yaw)*c,Math.sin(pitch),Math.cos(yaw)*c],right=[Math.cos(yaw),0,-Math.sin(yaw)],up=[-Math.sin(yaw)*Math.sin(pitch),c,-Math.cos(yaw)*Math.sin(pitch)];
  const eye=[8,13*.48,9].map((n,i)=>n+back[i]*dist),dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
  function proj(p){const v=p.map((n,i)=>n-eye[i]),k=canvas.height*.5/(Math.tan(95*Math.PI/360)*-dot(v,back));return [canvas.x+canvas.width*.5+dot(v,right)*k,canvas.y+canvas.height*.5-dot(v,up)*k];}
  const h=selected.map(v=>v+.5);h[1]+=Math.max(2.3,dist*.10);const a=proj(h),b=proj([h[0],h[1]+1,h[2]]);
  const mid=proj([h[0],h[1]-Math.max(2.3,dist*.10)*.40,h[2]]);
  await page.evaluate(pos=>{window.axisSample=pos;window.axisWidth=0;},mid);
  await page.locator('#reset').click();await page.waitForFunction(()=>window.axisWidth>=3);
  await page.evaluate(()=>{window.axisSample=null;});
  await page.locator('#layerMode').selectOption('full');await rendered();
  await page.evaluate(pos=>{window.watchTransform={pos,chunk:pos.map(n=>n>>4).join(',')};},selected);
  const beforeMove=traces.filter(m=>m.type==='edit'&&m.edit.tool==='move').length;
  const dragMove=async()=>{await page.mouse.move(...a);await page.mouse.down();await page.mouse.move(...b,{steps:4});
   await page.waitForFunction(()=>window.transformMesh?.to&&!window.transformMesh.from,null,{timeout:4500}).catch(async e=>{throw new Error(`${e.message} | ${JSON.stringify(await page.evaluate(()=>[window.watchTransform,window.transformMesh,document.querySelector('#message').textContent]))}`);});};
  await dragMove();assert.equal(traces.filter(m=>m.type==='edit'&&m.edit.tool==='move').length,beforeMove);
  await page.keyboard.press('Escape');await page.mouse.up();await page.waitForFunction(()=>window.transformMesh?.from&&!window.transformMesh.to);
  assert.equal(traces.filter(m=>m.type==='edit'&&m.edit.tool==='move').length,beforeMove);
  await dragMove();await page.mouse.up();await page.waitForFunction(()=>!document.querySelector('#steps button').disabled);
  assert.equal(traces.filter(m=>m.type==='edit'&&m.edit.tool==='move').length,beforeMove+1);
  await page.evaluate(()=>{window.watchTransform=null;});
  await page.locator('#layerMode').selectOption('single');await rendered();
  console.log('MOVE_PREVIEW_UI_OK block mesh moved before mouse-up, Esc restored original, one commit');
  assert.ok(traces.some(m=>m.type==='edit'&&m.edit.tool==='move'));
  await page.locator('[data-tool=extrude]').click();await page.locator('#steps [data-axis="1"][data-step="1"]').click();await page.waitForFunction(()=>document.querySelector('#selectionTitle').textContent.includes('2 格'));
  assert.ok(traces.some(m=>m.type==='edit'&&m.edit.tool==='extrude'));
  await page.locator('#topView').click();await page.locator('#layer').fill('3');await page.locator('#layer').press('Tab');await rendered();await page.locator('[data-tool=erase]').click();await page.mouse.click(canvas.x+canvas.width*.5+4,canvas.y+canvas.height*.5+4);await page.waitForFunction(()=>document.getElementById('stats').textContent.includes('250 可见方块'));
  await page.waitForTimeout(150);assert.equal(errs.length,0,errs.join('\n'));
  {
  // Use a tiny real Java structure so the visual form runs in every browser check.
  const field=(type,name,body)=>{const n=Buffer.from(name),head=Buffer.alloc(3);head[0]=type;head.writeUInt16BE(n.length,1);return Buffer.concat([head,n,body]);};
  const int=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;};
  const str=s=>{const b=Buffer.from(s),head=Buffer.alloc(2);head.writeUInt16BE(b.length);return Buffer.concat([head,b]);};
  const cat=(...parts)=>Buffer.concat(parts),end=Buffer.from([0]),list=(type,...rows)=>cat(Buffer.from([type]),int(rows.length),...rows);
  const jigsaw=cat(field(8,'id',str('minecraft:jigsaw')),field(8,'pool',str('minecraft:empty')),field(8,'joint',str('rollable')),
   field(10,'components',cat(field(8,'custom',str('preserve')),end)),field(3,'selection_priority',int(0)),end);
  const file=cat(Buffer.from([10]),str(''),field(3,'DataVersion',int(5023)),field(9,'size',list(3,int(3),int(3),int(3))),
   field(9,'palette',list(10,cat(field(8,'id',str('minecraft:jigsaw')),field(10,'properties',cat(field(8,'orientation',str('up_north')),end)),end))),
   field(9,'blocks',list(10,cat(field(9,'pos',list(3,int(1),int(0),int(1))),field(3,'state',int(0)),field(10,'nbt',jigsaw),end))),end);
  doc=await Structure.open(file);await page.locator('#layerMode').selectOption('full');await load();await rendered();
  await page.locator('#topView').click();await page.locator('[data-tool=pick]').click();
  const testBox=await page.locator('#scene').boundingBox();await page.mouse.click(testBox.x+testBox.width*.5,testBox.y+testBox.height*.5);
  await page.locator('#tileForm').waitFor();const jc=doc.cell([1,0,1]);
  await page.locator('#stateEditor').getByLabel('orientation',{exact:true}).selectOption('up_east');await page.locator('#stateApply').click();
  await page.waitForFunction(()=>!document.querySelector('#stateForm').inert&&document.querySelector('#stateApply').disabled);assert.equal(doc.snapshot().states.find(s=>s.props.orientation==='up_east').name,'minecraft:jigsaw');
  await page.getByLabel('pool',{exact:true}).fill('heaven:trial_dungeon/tower');await page.getByLabel('joint',{exact:true}).selectOption('aligned');
  await page.locator('#tileForm summary').filter({hasText:'components'}).click();await page.getByLabel('components / custom',{exact:true}).fill('nested');
  await page.locator('#tileForm > .entity-nbt-add > summary').click();await page.locator('#tileForm > .entity-nbt-add').getByLabel('可添加字段').selectOption('placement_priority');await page.getByLabel('placement_priority',{exact:true}).fill('31');
  assert.equal(doc.tileValue(jc,'pool').text,'"minecraft:empty"');
  await page.locator('#tileApply').click();await page.waitForFunction(()=>document.querySelector('#inspect').textContent.includes('heaven:trial_dungeon/tower'));
  assert.equal(doc.tileValue(jc,'joint').text,'"aligned"');assert.equal(doc.tileValue(jc,'placement_priority').type,3);assert.equal(doc.tileValue(jc,'components.custom').text,'"nested"');
  await page.getByRole('button',{name:'移除 placement_priority',exact:true}).click();await page.locator('#tileReset').click();
  assert.equal(await page.getByLabel('placement_priority',{exact:true}).inputValue(),'31');
  await page.locator('#tileAdvanced summary').click();await page.locator('#tilePath').fill('selection_priority');await page.locator('#tilePath').press('Enter');await page.waitForFunction(()=>document.querySelector('#tileValue').value==='0');
  await page.locator('#tileValue').fill('8L');await page.locator('#tileSave').click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('标签类型改变'));
  assert.equal(doc.tileValue(jc,'selection_priority').type,3);
  console.log('INSPECT_FORM_OK inline jigsaw states, string/enum/numeric controls, nested group, adding fields and SNBT type protection');
  }
  // The same searchable field and inline state rows drive the brush, not the sampled block.
  await page.locator('#tab-blocks').click();const brushId=page.locator('#name');
  await brushId.fill('oak_log');const logOption=page.getByRole('option',{name:'minecraft:oak_log',exact:true});await logOption.waitFor();
  if(assets)await logOption.locator('canvas').waitFor();
  await brushId.press('ArrowDown');await brushId.press('Enter');assert.equal(await brushId.inputValue(),'minecraft:oak_log');
  const brushImage=page.locator('#pane-blocks .block-current canvas');await brushImage.waitFor();
  await page.locator('#brush_axis').selectOption('x');assert.equal(await page.locator('#props').inputValue(),'axis=x');assert.equal(doc.state((doc.at(doc.cell([1,0,1]))>>1)-1).name,'minecraft:jigsaw');
  await page.getByRole('button',{name:'移除属性 axis',exact:true}).click();assert.equal(await page.locator('#props').inputValue(),'');
  await page.locator('#brushAdvanced summary').click();await page.locator('#props').fill('axis=z');assert.equal(await page.locator('#brush_axis').inputValue(),'z');
  await page.locator('#brushAdvanced summary').click();
  await page.locator('#brush_axis').selectOption('x');await page.locator('[data-tool=box]').click();
  await page.locator('#cornerA').fill('0,0,0');await page.locator('#cornerB').fill('0,0,0');await page.locator('#apply').click();
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);
  assert.deepEqual(doc.state((doc.at(0)>>1)-1),{name:'minecraft:oak_log',props:{axis:'x'}});
  await brushId.fill('stone');const stoneChoice=page.getByRole('option',{name:'minecraft:stone',exact:true});await stoneChoice.click();
  assert.equal(await page.locator('#props').inputValue(),'');assert.equal(await page.locator('#brush_axis').count(),0);
  console.log('BRUSH_PICKER_OK searchable textured blocks, inline properties, removal, advanced fallback, no edit before application');
  // Place a new chest through the UI, then repair a legacy shulker box in the same structure.
  {
   // Keep the legacy fixture deliberately free of a block-entity compound.
   const int=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;},cat=(...v)=>Buffer.concat(v),str=v=>cat(Buffer.from([0,Buffer.byteLength(v)]),Buffer.from(v)),end=Buffer.from([0]);
   const f=(t,k,v)=>cat(Buffer.from([t]),str(k),v),list=(t,...a)=>cat(Buffer.from([t]),int(a.length),...a),pos=(x,y,z)=>list(3,int(x),int(y),int(z));
   doc=await Structure.open(cat(Buffer.from([10]),str(''),f(3,'DataVersion',int(5023)),f(9,'size',pos(5,4,5)),
    f(9,'palette',list(10,cat(f(8,'id',str('minecraft:shulker_box')),end))),
    f(9,'blocks',list(10,cat(f(9,'pos',pos(2,0,2)),f(3,'state',int(0)),end))),end));
   await load();await rendered();await page.locator('#topView').click();await page.locator('[data-tool=pick]').click();
   const r=await page.locator('#scene').boundingBox(),center=[r.x+r.width*.5,r.y+r.height*.5];
   await page.mouse.click(...center);await page.locator('#initTile').waitFor();await page.locator('#initTile').click();await page.locator('#tileEditor').waitFor();
   const shulker=doc.cell([2,0,2]);assert.equal(doc.tileInfo(shulker).data.id,'minecraft:shulker_box');
   await page.locator('[data-tool=place]').click();await page.locator('#name').fill('minecraft:chest');await page.locator('#name').press('Escape');
   await page.mouse.click(...center);await page.waitForFunction(()=>document.querySelector('#stats').textContent.startsWith('2 可见'));
   const chest=doc.cell([2,1,2]);assert.equal(doc.tileInfo(chest).data.id,'minecraft:chest');
   await page.locator('[data-tool=pick]').click();await page.mouse.click(...center);await page.locator('#tileEditor').waitFor();
   const rootAdd=page.locator('#tileForm > .entity-nbt-add');
   assert.equal(await rootAdd.evaluate(el=>el===el.parentElement.lastElementChild),true);
   const addSummary=rootAdd.locator('summary[aria-label=添加字段]');assert.equal(await addSummary.textContent(),'+');await addSummary.press('Enter');await rootAdd.getByLabel('可添加字段').selectOption('LootTable');
   await page.getByLabel('LootTable',{exact:true}).fill('heaven:example');await page.locator('#tileApply').click();
   await page.waitForFunction(()=>document.querySelector('#inspect').textContent.includes('heaven:example'));
   assert.equal(doc.tileValue(chest,'LootTable').text,'"heaven:example"');
   await rootAdd.locator('summary').click();await rootAdd.getByLabel('可添加字段').selectOption('Items');
   const items=page.locator('#tileForm > details.entity-nbt-branch').filter({has:page.locator('summary').getByText('Items',{exact:true})});
   await items.getByRole('button',{name:'添加列表条目',exact:true}).click();
   const item=items.locator('.entity-nbt-children > details.entity-nbt-branch').first();
   const itemAdd=item.locator('.entity-nbt-add').first();
   assert.equal(await itemAdd.evaluate(el=>el===el.parentElement.lastElementChild),true);await itemAdd.locator('summary').click();
   await itemAdd.getByLabel('可添加字段').selectOption('id');
   const itemId=page.getByLabel('Items / 0 / id',{exact:true});await itemId.fill('diamond');
   await page.locator('.nbt-completion:popover-open').getByRole('option',{name:'minecraft:diamond',exact:true}).click();
   await page.locator('#tileApply').click();await page.waitForFunction(()=>document.querySelector('#inspect').textContent.includes('minecraft:diamond'));
   assert.match(doc.tileValue(chest,'Items').text,/"id":"minecraft:diamond"/);
   console.log('BLOCK_ENTITY_TREE_OK: chest Items expand, add compound entry, registry completion and apply');
   if(assets){
    for(const [p,name,props] of [[[0,0,0],'minecraft:chest',{type:'left',facing:'north'}],[[1,0,0],'minecraft:chest',{type:'right',facing:'north'}],
      [[0,0,1],'minecraft:waxed_exposed_copper_chest',{type:'left',facing:'south'}],[[1,0,1],'minecraft:red_shulker_box',{facing:'east'}]])doc.edit({tool:'place',points:[p],state:{name,props}});
    await load();await page.waitForFunction(()=>/6 可见/.test(document.querySelector('#stats').textContent)&&/6\/6 个状态有模型/.test(document.querySelector('#material').title));
    for(const tex of ['chest/normal','chest/normal_left','chest/normal_right','chest/copper_exposed_left','shulker/shulker','shulker/shulker_red'])assert.ok(texturePaths.has('assets/minecraft/textures/entity/'+tex+'.png'),tex);
    assert.ok((await page.evaluate(()=>window.textureUploadSizes.filter(n=>n===64).length))>=6,'container sheets must reach WebGL at their native size');
    if(process.env.VOXEL_CONTAINER_SCREENSHOT){
     await page.locator('#reset').click();await page.locator('#scene').evaluate(c=>c.dispatchEvent(new WheelEvent('wheel',{deltaY:-240,cancelable:true})));
     await page.locator('#scene').screenshot({path:process.env.VOXEL_CONTAINER_SCREENSHOT});
    }
   }
   console.log('CONTAINER_ENTITIES_OK native chest/shulker textures, new chest NBT editable, legacy box initializes on request');
  }
  if(process.env.VOXEL_TILE_FIXTURE){
   doc=await Structure.open(await readFile(process.env.VOXEL_TILE_FIXTURE));const p0=doc.snapshot();
   await page.locator('#layerMode').selectOption('full');await page.evaluate(data=>window.postMessage({type:'model',data},'*'),p0);
   await page.waitForFunction(size=>document.querySelector('#dimensions').textContent===size,p0.size.join(' × '));await rendered();
   await page.locator('#topView').click();await page.locator('[data-tool=pick]').click();
   const [x,y,z]=p0.size,b=await page.locator('#scene').boundingBox();const dist=Math.hypot(x,y,z)*1.07;
   const scale=b.height*.5/(Math.tan(95*Math.PI/360)*(dist+y*.48-1.78));
   await page.mouse.click(b.x+b.width*.5+(3.5-x/2)*scale,b.y+b.height*.5+(3.5-z/2)*scale);
   await page.locator('#tileEditor').waitFor();assert.equal(await page.locator('#tab-inspect').getAttribute('aria-selected'),'true');assert.match(await page.locator('#inspect').textContent(),/minecraft:chest/);
   assert.ok(await page.locator('#tileFields option[value="LootTable"]').count());
   await page.locator('#tileAdvanced summary').click();await page.locator('#tilePath').fill('LootTable');await page.locator('#tilePath').press('Enter');await page.waitForFunction(()=>document.querySelector('#tileValue').value.includes('simple_dungeon'));
   await page.locator('#tileValue').fill('"minecraft:chests/abandoned_mineshaft"');await page.locator('#tileSave').click();
   await page.waitForFunction(()=>document.querySelector('#inspect').textContent.includes('abandoned_mineshaft'));assert.match(doc.tileValue(doc.cell([3,1,3]),'LootTable').text,/abandoned_mineshaft/);
   console.log('TILE_UI_OK: pick chest, field suggestions, typed default, edit and refresh');
  }
  if(assets){
   doc=await Structure.open(create([8,8,8]));
   doc.edit({tool:'fill',box:[[3,0,3],[3,0,3]],state:{name:'minecraft:oak_stairs',props:{facing:'north',half:'bottom',shape:'straight',waterlogged:'false'}}});
   doc.edit({tool:'fill',box:[[3,2,3],[3,2,3]],state:{name:'minecraft:water',props:{level:'5'}}});
   doc.edit({tool:'fill',box:[[4,0,3],[4,1,3]],state:{name:'minecraft:stone',props:{}}});
   await page.locator('#layerMode').selectOption('full');await load();await page.waitForFunction(()=>document.querySelector('#dimensions').textContent==='8 × 8 × 8');await rendered();
   await page.locator('#tab-blocks').click();
   const stairButton=page.locator('#swatches button[title^="minecraft:oak_stairs["]').first(),cubeButton=page.locator('#swatches button[title="minecraft:stone"]');
   for(const btn of [stairButton,cubeButton])await btn.locator('canvas').waitFor();
   const image=async btn=>btn.locator('canvas').evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let alpha=0;const colors=new Set();for(let i=0;i<data.length;i+=4)if(data[i+3]){alpha++;colors.add(data[i]*65536+data[i+1]*256+data[i+2]);}return {alpha,colors:colors.size};});
   const stair=await image(stairButton),cube=await image(cubeButton);assert.ok(stair.alpha>250&&cube.alpha>250&&stair.alpha!==cube.alpha);assert.ok(stair.colors>8);
   await page.locator('#topView').click();await page.locator('[data-tool=pick]').click();
   const b=await page.locator('#scene').boundingBox(),scale=b.height*.5/(Math.tan(95*Math.PI/360)*(Math.hypot(8,8,8)*1.07+3.84-2));
   const xy=[b.x+b.width*.5+(3.5-4)*scale,b.y+b.height*.5+(3.5-4)*scale];
   await page.mouse.click(...xy);await page.locator('#stateEditor').waitFor();assert.match(await page.locator('#stateSummary').textContent(),/oak_stairs/);
   await page.locator('#stateEditor').getByLabel('facing',{exact:true}).selectOption('west');await page.locator('#stateEditor').getByLabel('half',{exact:true}).selectOption('top');await page.locator('#stateApply').click();
   await page.waitForFunction(()=>document.querySelector('#state_facing').value==='west'&&document.querySelector('#state_half').value==='top'&&document.querySelector('#stateApply').disabled);
   assert.equal(doc.state((doc.at(doc.cell([3,0,3]))>>1)-1).props.facing,'west');
   await page.locator('#tab-tools').click();await page.locator('#selectFluid').check();await page.mouse.click(...xy);assert.match(await page.locator('#stateSummary').textContent(),/minecraft:water/);
   await page.locator('#keyboard').click();await page.locator('#keysList button').first().click();await page.keyboard.press('Alt+k');await page.waitForFunction(()=>document.querySelector('#keysList button').textContent==='Alt+k');
   await page.locator('#settingsClose').click();await page.locator('#scene').focus();await page.keyboard.press('Alt+k');await page.waitForFunction(()=>document.querySelector('#mode').textContent==='查看');
   await page.keyboard.press('b');await page.waitForFunction(()=>document.querySelector('#mode').textContent==='框选区域');
   await page.locator('#cornerA').fill('3,0,3');await page.locator('#cornerB').fill('4,0,3');
   const oldLayer=await page.locator('#layer').inputValue();
   await page.mouse.move(...xy);await page.keyboard.down('Alt');await page.mouse.wheel(0,-120);await page.keyboard.up('Alt');
   await page.waitForFunction(()=>document.querySelector('#boxHint').textContent.includes('Y 0–1'));
   await page.locator('[data-tool=view]').click();await page.locator('[data-tool=box]').click();
   assert.match(await page.locator('#boxHint').textContent(),/Y 0–1/);
   assert.equal(await page.locator('#cornerA').inputValue(),'3,0,3');
   assert.equal(await page.locator('#cornerB').inputValue(),'4,0,3');
   assert.equal(await page.locator('#layer').inputValue(),oldLayer);
   await page.locator('#confirmBox').click();await page.waitForFunction(()=>document.querySelector('#selectionTitle').textContent==='已选 3 格');
   await page.mouse.move(...xy);await page.keyboard.down('Alt');await page.mouse.wheel(0,120);await page.keyboard.up('Alt');
   await page.waitForFunction(()=>document.querySelector('#selectionRange').textContent.includes('Y 0–0')&&document.querySelector('#selectionTitle').textContent==='已选 2 格');
   await page.locator('#steps [data-axis="1"][data-step="1"]').click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('未选中'));
   await page.locator('#tab-tools').click();await page.locator('#moveOverwrite').check();await page.locator('#overwriteList summary').click();
   await page.locator('#allowPick').click();await page.mouse.click(...xy);await page.waitForFunction(()=>document.querySelector('#allowList').textContent.includes('minecraft:water'));
   await page.locator('#steps [data-axis="1"][data-step="1"]').click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('minecraft:stone'));
   await page.locator('#allowBlock').fill('stone');await page.locator('#allowAdd').click();await page.locator('#steps [data-axis="1"][data-step="1"]').click();
   await page.waitForFunction(()=>document.querySelector('#selectionRange').textContent.includes('Y 1–1'));
   assert.equal(doc.state((doc.at(doc.cell([3,1,3]))>>1)-1).name,'minecraft:oak_stairs');
   await page.locator('#keyboard').click();await page.locator('#navigationPreset').selectOption('blender');await page.waitForFunction(()=>document.querySelector('#navigationHint').textContent.startsWith('中键旋转'));await page.locator('#settingsClose').click();
   await page.locator('[data-tool=view]').click();await page.locator('#reset').click();const scene=page.locator('canvas#scene');
   const before=await scene.screenshot();await page.mouse.move(b.x+b.width*.5,b.y+b.height*.5);await page.mouse.down({button:'middle'});await page.mouse.move(b.x+b.width*.5+70,b.y+b.height*.5+35,{steps:6});await page.mouse.up({button:'middle'});
   assert.notDeepEqual(await scene.screenshot(),before);
   await page.locator('#keyboard').click();await page.locator('#navigationPreset').selectOption('blockbench');await page.locator('#settingsClose').click();
   const beforePan=await scene.screenshot();await page.mouse.move(b.x+b.width*.5,b.y+b.height*.5);await page.mouse.down({button:'right'});await page.mouse.move(b.x+b.width*.5+55,b.y+b.height*.5-30,{steps:5});await page.mouse.up({button:'right'});
   assert.notDeepEqual(await scene.screenshot(),beforePan);
   await page.locator('#tab-blocks').click();
   if(process.env.VOXEL_THUMBS_SCREENSHOT)await page.locator('#swatches').screenshot({path:process.env.VOXEL_THUMBS_SCREENSHOT});
   console.log('FEATURES_05_OK model thumbnails, two mouse presets, Alt-wheel expands existing or draft Y range, whitelist by sampling and ID');
  }
  // Real screenshots while the button is held: move the pointer before the baseline so the hover frame is unchanged.
  doc=await Structure.open(create([10,7,10]));
  doc.edit({tool:'fill',box:[[2,0,4],[7,0,4]],state:{name:'minecraft:stone',props:{}}});
  await page.locator('#layerMode').selectOption('full');await load();await page.waitForFunction(()=>document.querySelector('#dimensions').textContent==='10 × 7 × 10');await rendered();
  await page.locator('#topView').click();
  const scene=page.locator('#scene'),rect=await scene.boundingBox(),distB=Math.hypot(10,7,10)*1.07,backB=[0,Math.sin(1.565),Math.cos(1.565)],eyeB=[5,7*.48+distB*backB[1],5+distB*backB[2]];
  function point(x,y,z){const v=[x-eyeB[0],y-eyeB[1],z-eyeB[2]],scale=rect.height*.5/(Math.tan(95*Math.PI/360)*-(v[1]*backB[1]+v[2]*backB[2]));
   return [rect.x+rect.width*.5+v[0]*scale,rect.y+rect.height*.5-(v[1]*backB[2]-v[2]*backB[1])*scale];}
  async function examineDrag(mode,a,b,id,check,cancel=false){
   await page.locator(`[data-tool=${mode}]`).click();if(id){await page.locator('#name').fill(id);await page.locator('#name').press('Escape');}
   const before=traces.filter(x=>x.type==='edit').length;
   await page.mouse.move(...a);await page.waitForTimeout(65);const ss=await scene.screenshot();
   await page.mouse.down();await page.waitForTimeout(130);assert.notDeepEqual(await scene.screenshot(),ss,mode+' only updated after release');assert.equal(traces.filter(x=>x.type==='edit').length,before);
   await page.mouse.move(...b,{steps:1});await page.waitForTimeout(100);
   if(cancel){await page.keyboard.press('Escape');await page.mouse.up();assert.equal(traces.filter(x=>x.type==='edit').length,before);return;}
   await page.mouse.up();await page.waitForFunction(()=>!document.querySelector('#save').disabled);
   const edits=traces.filter(x=>x.type==='edit');assert.equal(edits.length,before+1);assert.ok(edits.at(-1).edit.points.length>=5);check();
  }
  const nameAt=p=>doc.state((doc.at(doc.cell(p))>>1)-1)?.name;
  const begin=point(2.5,1,4.5),end=point(7.5,1,4.5);
  await examineDrag('paint',begin,end,'minecraft:bricks',()=>{for(let x=2;x<=7;x++)assert.equal(nameAt([x,0,4]),'minecraft:bricks');});
  await examineDrag('erase',begin,end,null,()=>{},true);assert.equal(doc.snapshot().visible,6);
  await examineDrag('place',begin,end,'minecraft:amethyst_block',()=>{for(let x=2;x<=7;x++)assert.equal(nameAt([x,1,4]),'minecraft:amethyst_block');});
  await examineDrag('erase',point(2.5,2,4.5),point(7.5,2,4.5),null,()=>{for(let x=2;x<=7;x++)assert.equal(nameAt([x,1,4]),undefined);});
  await page.locator('[data-tool=box]').click();await page.locator('#deselect').click();
  const beforeFillPreview=traces.filter(m=>m.type==='edit').length;
  await page.evaluate(()=>{window.captureSelection=true;});await page.mouse.click(...begin);
  await page.waitForFunction(()=>!window.captureSelection&&window.selectionWidth>0);
  const oneCellWidth=await page.evaluate(()=>window.selectionWidth);
  await page.evaluate(()=>{window.captureSelection=true;});await page.mouse.move(...end);
  await page.waitForFunction(min=>!window.captureSelection&&window.selectionWidth>min,oneCellWidth+10);
  assert.match(await page.locator('#boxHint').textContent(),/预览 6 × 1 × 1/);
  assert.equal(await page.locator('#cornerB').inputValue(),'');assert.equal(await page.locator('#apply').isDisabled(),true);
  const fillWheel=(deltaY,shiftKey=false)=>page.locator('#scene').evaluate((c,[deltaY,shiftKey])=>c.dispatchEvent(new WheelEvent('wheel',{deltaY,altKey:true,shiftKey,cancelable:true})),[deltaY,shiftKey]);
  const fillLayer=await page.locator('#layer').inputValue();
  await fillWheel(-100);assert.match(await page.locator('#boxHint').textContent(),/预览 6 × 2 × 1.*Y 0–1/);
  assert.equal(await page.locator('#apply').isDisabled(),true);

  await page.mouse.click(...end);await page.mouse.move(...begin);
  assert.equal(await page.locator('#cornerB').inputValue(),'7, 1, 4');assert.match(await page.locator('#boxHint').textContent(),/选区 6 × 2 × 1.*Y 0–1/);
  assert.equal(traces.filter(m=>m.type==='edit').length,beforeFillPreview);await page.locator('#deselect').click();
  await page.locator('#cornerA').fill('1,2,2');await page.locator('#cornerB').fill('2,2,2');
  await fillWheel(-100);await fillWheel(-100,true);assert.match(await page.locator('#boxHint').textContent(),/预览 2 × 3 × 1.*Y 1–3/);
  await fillWheel(100);assert.match(await page.locator('#boxHint').textContent(),/预览 2 × 2 × 1.*Y 1–2/);
  assert.equal(await page.locator('#layer').inputValue(),fillLayer);
  await page.locator('#name').fill('minecraft:gold_block');await page.locator('#name').press('Escape');await page.locator('#apply').click();
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);
  const fillEdit=traces.filter(m=>m.type==='edit').at(-1).edit;assert.deepEqual(fillEdit.box,[[1,1,2],[2,2,2]]);
  assert.equal(nameAt([1,1,2]),'minecraft:gold_block');assert.equal(nameAt([1,2,2]),'minecraft:gold_block');assert.equal(nameAt([1,3,2]),undefined);
  await page.locator('#deselect').click();
  console.log('FILL_PREVIEW_OK hovering previews the second corner; Alt/Shift wheel adjusts the preview and committed Y bounds');
  await page.locator('[data-tool=box]').click();await page.locator('#cornerA').fill('2,0,4');await page.locator('#cornerB').fill('7,0,4');await page.locator('#confirmBox').click();
  await page.waitForFunction(()=>document.querySelector('#selectionTitle').textContent==='已选 6 格');
  await page.locator('#reset').click();await page.evaluate(()=>{window.captureSelection=true;});
  // Force a frame and check real framebuffer pixels, not the visibility of a DOM wrapper.
  await page.locator('#layer').evaluate(e=>e.dispatchEvent(new Event('change')));
  await page.waitForFunction(()=>window.selectionPixels>35&&window.selectionVertices===144);
  const vfov=await page.evaluate(()=>2*Math.atan(1/Math.hypot(window.cameraMatrix[1],window.cameraMatrix[5],window.cameraMatrix[9]))*180/Math.PI);assert.ok(Math.abs(vfov-95)<.001);
  console.log('LIVE_BRUSH_OK: paint, place, erase changed rendered pixels before release; one edit per stroke; cancel discards; one high-contrast outline with no per-block squares');
  await page.locator('#tab-blocks').click();
  doc=await Structure.open(create([10,11,10]));
  for(let i=0;i<100;i++)doc.edit({tool:'place',points:[[i%10,0,Math.floor(i/10)]],state:{name:'minecraft:stone',props:{fixture:''+i}}});
  await load();await page.waitForFunction(()=>document.querySelector('#swatches').children.length===100);
  await page.evaluate(()=>{
   const grid=document.getElementById('swatches'),button=grid.querySelector('[data-state="57"]');
   grid.scrollTop=button.offsetTop-grid.firstElementChild.offsetTop-14;
   window.midSwatch=button;window.paletteScroll=grid.scrollTop;
  });
  await page.locator('#swatches [data-state="57"]').click();
  assert.ok(await page.evaluate(()=>{const grid=document.getElementById('swatches');return window.paletteScroll>0&&grid.scrollTop===window.paletteScroll&&grid.querySelector('.active')===window.midSwatch&&document.activeElement===window.midSwatch&&document.getElementById('props').value==='fixture=57';}),'clicking a swatch moved the palette viewport or discarded the original button');
  if(assets){await page.locator('#material').click();assert.ok(await page.evaluate(()=>document.getElementById('swatches').scrollTop===window.paletteScroll),'rebuilding the palette moved the viewport');await page.locator('#material').click();}
  console.log('PALETTE_SCROLL_OK: row, original focused button and scroll offset stay when selecting a state');
  doc=await Structure.open(create([12,12,12]));doc.edit({tool:'fill',box:[[2,1,2],[9,4,9]],state:{name:'minecraft:stone',props:{}}});
  await load();await page.waitForFunction(()=>document.querySelector('#dimensions').textContent==='12 × 12 × 12');await rendered();
  await page.locator('[data-tool=place]').click();await page.locator('#reset').click();
  await page.waitForFunction(()=>window.cameraMatrix?.length===16);await page.waitForTimeout(40);
  const orbit=await page.evaluate(()=>window.cameraMatrix),editsBefore=traces.filter(m=>m.type==='edit').length;
  await page.locator('#scene').focus();await page.keyboard.press('f');await page.locator('#flightHelp').waitFor();
  assert.equal(await page.locator('#flyView').getAttribute('aria-pressed'),'true');
  const pos=async()=>((await page.locator('#coords').textContent()).match(/位置 ([+-]?[\d.]+), ([+-]?[\d.]+), ([+-]?[\d.]+)/)||[]).slice(1).map(Number);
  const axis=()=>page.evaluate(()=>[-window.cameraMatrix[3],-window.cameraMatrix[7],-window.cameraMatrix[11]]);
  const press=async key=>{await page.keyboard.down(key);await page.waitForTimeout(340);await page.keyboard.up(key);};
  await page.waitForFunction(()=>document.querySelector('#coords').textContent.startsWith('位置'));
  let before=await pos();await press('w');let after=await pos();
  assert.ok(after[0]<before[0]&&after[2]<before[2],`W must move forward: ${before} -> ${after}`);
  before=after;await press('s');after=await pos();assert.ok(after[0]>before[0]&&after[2]>before[2],'S must move back');
  before=after;await press('d');after=await pos();assert.ok(after[0]>before[0]&&after[2]<before[2],'D must strafe right');
  before=after;await press('a');after=await pos();assert.ok(after[0]<before[0]&&after[2]>before[2],'A must strafe left');
  before=after;await press('Space');after=await pos();assert.ok(after[1]>before[1]+.4);
  before=after;await press('Shift');after=await pos();assert.ok(after[1]<before[1]-.4);
  const wheel=deltaY=>page.locator('#scene').evaluate((c,deltaY)=>c.dispatchEvent(new WheelEvent('wheel',{deltaY,cancelable:true})),deltaY);
  const speed=async()=>Number((await page.locator('#coords').textContent()).match(/([\d.]+) 格\/秒/)?.[1]);
  const checkSpeed=v=>page.waitForFunction(v=>document.querySelector('#coords').textContent.includes(`· ${v.toFixed(1)} 格/秒`),v);
  assert.equal(await speed(),16);await wheel(-100);await checkSpeed(17);await wheel(-2000);await checkSpeed(24);await wheel(3000);await checkSpeed(8);
  const mouseLook=async (dx,dy)=>{
   const locked=await page.evaluate(()=>document.pointerLockElement?.id==='scene');
   if(locked)await page.evaluate(([movementX,movementY])=>document.getElementById('scene').dispatchEvent(new MouseEvent('mousemove',{movementX,movementY,bubbles:true})),[dx,dy]);
   else{
    const r=await page.locator('#scene').boundingBox(),x=r.x+r.width*.5,y=r.y+r.height*.5;
    await page.mouse.move(4,4);await page.mouse.move(x,y);await page.mouse.move(x+dx,y+dy,{steps:3});
   }
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  const rFlight=await page.locator('#scene').boundingBox();
  if(!await page.evaluate(()=>document.pointerLockElement))await page.mouse.move(rFlight.x+rFlight.width*.5,rFlight.y+rFlight.height*.5);
  let facing=await axis();await mouseLook(0,-60);let next=await axis();assert.ok(next[1]<facing[1]-.07,'mouse up must look up');assert.ok(Math.abs(Math.asin(facing[1])-Math.asin(next[1])-60*.0028*.85)<.015,'flight mouse sensitivity should be 85% of its former value');
  facing=next;await mouseLook(65,0);next=await axis();assert.ok(next[0]<facing[0]-.06&&next[2]>facing[2]+.06,'mouse right must turn right');
  for(const key of ['i','j','k','l']){await page.keyboard.press(key);assert.deepEqual(await axis(),next);}
  await page.keyboard.down('w');await page.waitForTimeout(100);await page.locator('#flyView').focus();before=await pos();
  await page.waitForTimeout(100);assert.deepEqual(await pos(),before,'movement must stop on blur');await page.keyboard.up('w');
  const sceneBox=await page.locator('#scene').boundingBox();await page.mouse.click(sceneBox.x+sceneBox.width*.5,sceneBox.y+sceneBox.height*.5);
  assert.equal(traces.filter(m=>m.type==='edit').length,editsBefore,'flight must not modify blocks');
  await mouseLook(-40,20);await press('Space');
  const endFlight=await page.evaluate(()=>window.cameraMatrix);assert.notDeepEqual(endFlight,orbit);
  const expectPose=expected=>page.waitForFunction(expected=>window.cameraMatrix?.every((v,i)=>Math.abs(v-expected[i])<1e-5),expected);
  await page.keyboard.press('Escape');await page.locator('#flightHelp').waitFor({state:'hidden'});await expectPose(endFlight);
  assert.equal(await page.locator('#mode').textContent(),'放置');
  await page.locator('#flyView').click();await page.locator('#flightHelp').waitFor();await expectPose(endFlight);
  await checkSpeed(16);await mouseLook(0,-35);const viaButton=await page.evaluate(()=>window.cameraMatrix);assert.notDeepEqual(viaButton,endFlight);
  await page.locator('#flyView').evaluate(b=>b.click());await page.locator('#flightHelp').waitFor({state:'hidden'});await expectPose(viaButton);
  const cursorRequests=()=>traces.filter(m=>m.type==='centerCursor');
  const rReturn=await page.locator('#scene').boundingBox(),off=[Math.floor(rReturn.x+rReturn.width*.3),Math.floor(rReturn.y+rReturn.height*.35)];
  await page.mouse.move(...off);await page.locator('#scene').focus();await page.keyboard.press('f');await page.locator('#flightHelp').waitFor();
  await page.waitForTimeout(80);const startRequests=cursorRequests().length;
  await page.keyboard.press('f');await page.locator('#flightHelp').waitFor({state:'hidden'});
  for(let i=0;i<30&&cursorRequests().length===startRequests;i++)await page.waitForTimeout(15);
  assert.equal(cursorRequests().length,startRequests+1,'flight exit must request a single cursor recenter');
  const request=cursorRequests().at(-1),dpr=await page.evaluate(()=>devicePixelRatio);
  assert.ok(Math.abs(request.dx-Math.round((rReturn.x+rReturn.width*.5-off[0])*dpr))<=2,JSON.stringify(request));
  assert.ok(Math.abs(request.dy-Math.round((rReturn.y+rReturn.height*.5-off[1])*dpr))<=2,JSON.stringify(request));
  console.log('FLIGHT_CURSOR_RETURN_OK centered Webview coordinates sent once, after pointer unlock');
  console.log('FLIGHT_MOUSE_OK WASD/Space/Shift travel, mouse look only, 16 default, wheel 8–24, no edits or view jump');
  if(real){const t=performance.now();doc=await Structure.open(await readFile(real));const parsed=performance.now()-t;const view=doc.snapshot(),snapshotMs=performance.now()-t-parsed;await page.locator('#layerMode').selectOption('full');await page.evaluate(data=>window.postMessage({type:'model',data},'*'),view);
   await page.waitForFunction(size=>document.getElementById('dimensions').textContent===size,view.size.join(' × '));await rendered();
   if(assets){await page.waitForFunction(()=>/状态有模型/.test(document.querySelector('#material').title));await rendered();}
   console.log('LARGE_WEBVIEW_OK',view.size,view.records,view.visible,`parse ${Math.round(parsed)}ms snapshot ${Math.round(snapshotMs)}ms end-to-end ${Math.round(performance.now()-t)}ms`);
   if(process.env.VOXEL_SCREENSHOT)await page.screenshot({path:process.env.VOXEL_SCREENSHOT});
  }
  await page.locator('[data-tool=view]').click();
  await page.locator('#tab-blocks').focus();await page.keyboard.press('ArrowRight');await page.locator('#inspectEmpty').waitFor();
  assert.equal(await page.locator('#tab-inspect').getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');await page.locator('#copyTemplate').waitFor();await page.keyboard.press('ArrowLeft');await page.locator('#resize').waitFor();await page.locator('#tab-blocks').click();
  assert.ok(!(await page.locator('#paletteAdd').isVisible()));await page.getByText('管理调色板变体',{exact:true}).click();await page.locator('#paletteAdd').waitFor();
  await page.getByText('管理调色板变体',{exact:true}).click();
  const areas=await page.evaluate(()=>{
   const box=s=>document.querySelector(s).getBoundingClientRect();
   return [box('.sidebar-view').bottom,box('.workspace-nav').top,box('.workspace-nav').bottom,box('.sidebar-body').top];
  });assert.ok(areas[0]<=areas[1]+1&&areas[2]<=areas[3]+1);
  await page.locator('[data-tool=box]').click();
  const context=page.locator('#transformPanel'),contextSummary=context.locator('summary.context-summary');
  assert.equal(await page.locator('#contextTool').textContent(),'框选');
  await page.locator('#cornerA').fill('1,1,1');
  await contextSummary.focus();await page.keyboard.press('Enter');assert.equal(await context.getAttribute('open'),null);
  await page.locator('#pane-blocks').getByRole('heading',{name:'调色板'}).waitFor();
  await page.keyboard.press('Enter');assert.notEqual(await context.getAttribute('open'),null);
  assert.equal(await page.locator('#cornerA').inputValue(),'1,1,1');await page.locator('#deselect').click();
  if(process.env.VOXEL_SIDEBAR_SCREENSHOT){await page.locator('#sidebarViewTitle').scrollIntoViewIfNeeded();await page.locator('.sidebar').screenshot({path:process.env.VOXEL_SIDEBAR_SCREENSHOT});}
  await page.locator('[data-tool=view]').click();
  const splitter=page.locator('#sidebarSplitter'),sidebarBox=()=>page.locator('.sidebar').boundingBox();
  const dragSplitter=async (dx,dy)=>{
   const r=await splitter.boundingBox(),x=r.x+r.width/2,y=r.y+r.height/2;
   await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:4});await page.mouse.up();
  };
  const originalWidth=(await sidebarBox()).width;
  await dragSplitter(-80,0);assert.ok(Math.abs((await sidebarBox()).width-originalWidth-80)<2);
  await splitter.focus();await page.keyboard.press('ArrowLeft');assert.ok(Math.abs((await sidebarBox()).width-originalWidth-90)<2);
  await page.keyboard.press('End');assert.ok((await page.locator('.viewport').boundingBox()).width>=179);
  await page.keyboard.press('Home');assert.ok((await sidebarBox()).width>=219);
  await dragSplitter(Math.round((await sidebarBox()).width-originalWidth),0);
  assert.ok(Math.abs((await sidebarBox()).width-originalWidth)<2);
  await page.setViewportSize({width:440,height:740});
  await page.waitForFunction(()=>document.querySelector('#sidebarSplitter').getAttribute('aria-orientation')==='horizontal');
  const originalHeight=(await sidebarBox()).height;await dragSplitter(0,-38);
  assert.ok(Math.abs((await sidebarBox()).height-originalHeight-38)<2);
  const savedSplit=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('voxelState')).sidebarSize);
  assert.ok(Math.abs(savedSplit.width-originalWidth)<2&&Math.abs(savedSplit.height-originalHeight-38)<2);
  await dragSplitter(0,38);
  const narrow=await page.evaluate(()=>{
   const canvas=document.querySelector('.viewport').getBoundingClientRect(),sidebar=document.querySelector('.sidebar').getBoundingClientRect(),body=document.querySelector('.sidebar-body');
   return sidebar.top>=canvas.bottom-1&&canvas.height>180&&sidebar.width>320&&body.scrollWidth===body.clientWidth&&document.body.scrollWidth===innerWidth;
  });assert.ok(narrow,'narrow layout must stack the panels, with no horizontal overflow');
  if(process.env.VOXEL_NARROW_SCREENSHOT)await page.screenshot({path:process.env.VOXEL_NARROW_SCREENSHOT});
  console.log('SIDEBAR_LAYOUT_OK: keyboard tabs, tool pane, collapsed advanced actions, usable narrow layout');
  await page.locator('#tab-blocks').click();await page.locator('[data-tool=box]').click();
  await page.locator('#boxPanel #maskPanel').waitFor();assert.equal(await page.locator('#maskOpen').isDisabled(),true);assert.equal(await page.locator('#maskDialog').count(),0);
  assert.equal(await page.locator('[data-tool=replace]').count(),0);
  if(maskCatalog){
   await page.setViewportSize({width:1190,height:740});
   prefs={...prefs,resource:{kind:'jar'}};
   await page.evaluate(({prefs,catalog,collisions})=>{window.postMessage({type:'prefs',prefs},'*');window.postMessage({type:'maskCatalog',catalog},'*');window.postMessage({type:'collisionShapes',catalog:collisions},'*');},{prefs,catalog:maskCatalog,collisions});
   doc=await Structure.open(create([8,6,8]));
   for(const [pos,name] of [[[2,1,3],'oak_log'],[[3,1,3],'birch_log'],[[4,1,3],'stone'],[[3,2,3],'stone']])doc.edit({tool:'place',points:[pos],state:{name:'minecraft:'+name,props:{}}});
   await load();await page.waitForFunction(()=>document.querySelector('#dimensions').textContent==='8 × 6 × 8');await rendered();
   await page.locator('#maskOpen').click();await page.locator('#maskTree').getByLabel('谓词类型').first().selectOption('all_of');
   await page.locator('#maskTree').getByLabel('谓词类型').nth(1).selectOption('matching_blocks');
   const maskBlock=page.locator('#maskTree').getByLabel('blocks 1');await maskBlock.fill('oak_log');
   const maskOak=page.locator('#maskTree').getByRole('option',{name:'minecraft:oak_log',exact:true});await maskOak.waitFor();
   if(assets)await maskOak.locator('canvas').waitFor();await maskOak.click();
   assert.equal(await maskBlock.inputValue(),'minecraft:oak_log');await page.locator('#maskTree .block-current canvas').first().waitFor();
   await maskBlock.fill('#minecraft:logs');
   const tagOption=page.locator('#maskTree').getByRole('option',{name:'#minecraft:logs',exact:true});await tagOption.click();
   assert.equal(await maskBlock.inputValue(),'#minecraft:logs');assert.equal(await page.locator('#maskTree .block-current .tag-image').count(),1);
   await page.getByRole('button',{name:'＋ 添加子谓词'}).click();
   await page.locator('#maskTree').getByLabel('谓词类型').nth(2).selectOption('not');
   await page.locator('#maskTree').getByLabel('谓词类型').nth(3).selectOption('matching_blocks');
   await page.locator('#maskTree').getByLabel('offset Y',{exact:true}).last().fill('1');
   await page.getByText('导入 / 复制 JSON',{exact:true}).click();
   for(const type of ['unobstructed','matching_biomes','would_survive','inside_world_bounds']){
    await page.locator('#maskJson').fill(JSON.stringify({type:'minecraft:not',predicate:{type:'minecraft:'+type}}));await page.locator('#maskImport').click();assert.ok((await page.locator('#maskError').textContent()).includes(type));
   }
   await page.getByRole('button',{name:'＋ 添加子谓词'}).click();
   await page.locator('#maskTree').getByLabel('谓词类型').last().selectOption('height_range');
   assert.match(await page.locator('.mask-y-range').textContent(),/0–5/);
   await page.locator('#maskTree').getByLabel('min_inclusive 锚点').selectOption('absolute');
   await page.locator('#maskTree').getByLabel('min_inclusive Y').fill('1');
   await page.locator('#maskTree').getByLabel('max_inclusive 锚点').selectOption('absolute');
   await page.locator('#maskTree').getByLabel('max_inclusive Y').fill('1');
   await page.locator('#maskSave').click();await page.locator('#maskOptions').waitFor({state:'hidden'});assert.equal(await page.locator('#maskEnabled').isChecked(),true);
   await page.locator('#cornerA').fill('2,1,3');await page.locator('#cornerB').fill('4,1,3');await page.locator('#name').fill('minecraft:gold_block');await page.locator('#name').press('Escape');
   await page.locator('#apply').click();await page.waitForFunction(()=>!document.querySelector('#save').disabled);
   const blockName=p=>doc.state((doc.at(doc.cell(p))>>1)-1)?.name;
   assert.equal(blockName([2,1,3]),'minecraft:gold_block');assert.equal(blockName([3,1,3]),'minecraft:birch_log');assert.equal(blockName([4,1,3]),'minecraft:stone');
   await page.locator('[data-tool=paint]').click();await page.locator('#paintMask #maskPanel').waitFor();assert.equal(await page.locator('#maskEnabled').isChecked(),false);await page.locator('#maskOpen').click();
   const open=await page.locator('#maskJson').isVisible();if(!open)await page.getByText('导入 / 复制 JSON',{exact:true}).click();
   await page.locator('#maskJson').fill('{"type":"minecraft:matching_block_tag","tag":"minecraft:logs"}');await page.locator('#maskImport').click();
   assert.equal(await page.locator('#maskTree').getByLabel('方块标签',{exact:true}).inputValue(),'minecraft:logs');await page.locator('#maskSave').click();
   await page.locator('#layerMode').selectOption('single');await page.locator('#layer').fill('1');await page.locator('#layer').press('Tab');await rendered();await page.locator('#topView').click();
   await page.locator('#name').fill('minecraft:amethyst_block');
   const r=await page.locator('#scene').boundingBox(),scale=r.height*.5/(Math.tan(95*Math.PI/360)*(Math.hypot(8,6,8)*1.07+6*.48-2));
   await page.mouse.move(r.x+r.width*.5-.5*scale,r.y+r.height*.5-.5*scale);await page.mouse.down();await page.waitForTimeout(100);
   assert.equal(blockName([3,1,3]),'minecraft:birch_log');await page.mouse.move(r.x+r.width*.5+.5*scale,r.y+r.height*.5-.5*scale,{steps:3});await page.mouse.up();await page.waitForFunction(()=>!document.querySelector('#save').disabled);
   assert.equal(blockName([3,1,3]),'minecraft:amethyst_block');assert.equal(blockName([4,1,3]),'minecraft:stone');
   await page.locator('[data-tool=place]').click();await page.locator('#paintMask #maskPanel').waitFor();
   assert.equal(await page.locator('#maskEnabled').isChecked(),true);
   const projectCell=(x,z)=>[r.x+r.width*.5+(x+.5-4)*scale,r.y+r.height*.5+(z+.5-4)*scale];
   await page.mouse.click(...projectCell(4,4));await page.waitForFunction(()=>!document.querySelector('#save').disabled);
   assert.equal(blockName([4,1,4]),undefined,'without offset the shared log mask tests the empty placement cell');
   await page.locator('#maskOpen').click();assert.equal(await page.locator('#maskTree').getByLabel('方块标签',{exact:true}).inputValue(),'minecraft:logs');
   if(!await page.locator('#maskJson').isVisible())await page.getByText('导入 / 复制 JSON',{exact:true}).click();
   await page.locator('#maskJson').fill('{"type":"minecraft:matching_blocks","blocks":"minecraft:stone","offset":[0,0,-1]}');
   await page.locator('#maskImport').click();await page.locator('#maskSave').click();
   await page.mouse.move(...projectCell(3,4));await page.mouse.down();await page.mouse.move(...projectCell(4,4),{steps:4});await page.mouse.up();
   await page.waitForFunction(()=>!document.querySelector('#save').disabled);
   assert.equal(blockName([3,1,4]),undefined);assert.equal(blockName([4,1,4]),'minecraft:amethyst_block');
   await page.locator('#maskEnabled').uncheck();await page.locator('[data-tool=paint]').click();assert.equal(await page.locator('#maskEnabled').isChecked(),false);
   await page.locator('#maskOpen').click();assert.equal(await page.locator('#maskTree').getByLabel('blocks 1',{exact:true}).inputValue(),'minecraft:stone');await page.locator('#maskCancel').click();

   await page.locator('[data-tool=box]').click();await page.locator('#boxPanel #maskPanel').waitFor();await page.locator('#maskOpen').click();
   assert.match(await page.locator('.mask-y-range').textContent(),/0–5/);await page.locator('#maskCancel').click();
   console.log('MASK_UI_OK: shared paint/place mask, actual destination and offset, independent fill settings, JAR tags and JSON');
  }
  doc=await Structure.open(create([10,8,10]));
  doc.edit({tool:'place',points:[[4,1,4]],state:{name:'minecraft:oak_log',props:{axis:'x'}}});
  doc.edit({tool:'place',points:[[5,1,4]],state:{name:'minecraft:observer',props:{facing:'east'}}});
  await load();await rendered();await page.locator('#topView').click();await page.locator('[data-tool=box]').click();
  await page.locator('#cornerA').fill('4,1,4');await page.locator('#cornerB').fill('5,1,4');await page.locator('#confirmBox').click();
  await page.waitForFunction(()=>document.querySelector('#selectionTitle').textContent==='已选 2 格');
  assert.equal(await page.locator('#mode').textContent(),'框选区域');
  assert.equal(await page.locator('#cornerA').inputValue(),'4, 1, 4');assert.equal(await page.locator('#cornerB').inputValue(),'5, 1, 4');
  assert.equal(await page.locator('#apply').isEnabled(),true);
  assert.match(await page.locator('#pivotText').textContent(),/选区中心/);
  const canvasBox=await page.locator('#scene').boundingBox();
  const pitchTop=1.565,cc=Math.cos(pitchTop),ss=Math.sin(pitchTop),distTop=Math.hypot(10,8,10)*1.07;
  const topProj=([x,y,z])=>{const dy=y-(8*.48+ss*distTop),dz=z-(5+cc*distTop),k=canvasBox.height*.5/(Math.tan(95*Math.PI/360)*(-ss*dy-cc*dz));return [canvasBox.x+canvasBox.width*.5+(x-5)*k,canvasBox.y+canvasBox.height*.5-(dy*cc-dz*ss)*k];};
  await page.locator('#layer').fill('1');await page.locator('#layer').press('Tab');await page.waitForTimeout(100);
  await page.locator('#pickPivot').click();await page.mouse.click(...topProj([3.5,1.015,3.5]));
  assert.match(await page.locator('#pivotText').textContent(),/3.5, 1.5, 3.5/);
  await page.waitForTimeout(80);
  const atAngle=a=>topProj([3.5+2.3*1.23*Math.sin(a),1.5,3.5+2.3*1.23*Math.cos(a)]);
  // Start on the visible Y-ring sphere and drag a quarter turn before committing.
  const start=Math.PI/8,initial=atAngle(start);
  await page.mouse.move(...initial);await page.mouse.down();
  for(let n=1;n<=8;n++)await page.mouse.move(...atAngle(start+n*Math.PI/16));
  await page.waitForFunction(()=>document.querySelector('#coords').textContent.includes('Y 轴：90°'));
  const at=(x,y,z)=>doc.state((doc.at(doc.cell([x,y,z]))>>1)-1);
  assert.equal(at(5,1,4).name,'minecraft:observer');
  await page.mouse.up();await page.waitForFunction(()=>!document.querySelector('#save').disabled);
  assert.equal(at(4,1,2).props.axis,'z');assert.equal(at(4,1,1).props.facing,'north');
  assert.ok(traces.some(m=>m.type==='edit'&&m.edit.tool==='rotate'&&m.edit.axis===1));
  await page.locator('#resetPivot').click();assert.match(await page.locator('#pivotText').textContent(),/选区中心/);
  await page.locator('#tab-blocks').click();await page.getByText('管理调色板变体',{exact:true}).click();await page.locator('#paletteClean').click();
  await page.waitForFunction(()=>document.querySelector('#stats').textContent.includes('3 种状态'),{},{timeout:5000}).catch(async e=>{throw new Error(`${e.message} | ${await page.locator('#stats').textContent()} | ${await page.locator('#message').textContent()} | ${JSON.stringify(traces.at(-1))}`);});
  assert.equal(doc.paletteCount,3);assert.equal(at(4,1,1).props.facing,'north');
  console.log('ROTATE_AND_CLEAN_OK ring drag with custom pivot, snapped quarter turn, oriented state and removal of unused palette slots');
  doc=await Structure.open(create([10,8,10]));
  doc.edit({tool:'place',points:[[4,1,4]],state:{name:'minecraft:oak_log',props:{axis:'x'}}});
  doc.edit({tool:'place',points:[[5,1,4]],state:{name:'minecraft:observer',props:{facing:'east'}}});
  await load();await rendered();await page.locator('#topView').click();await page.locator('[data-tool=box]').click();
  await page.locator('#cornerA').fill('4,1,4');await page.locator('#cornerB').fill('5,1,4');await page.locator('#confirmBox').click();
  await page.waitForFunction(()=>document.querySelector('#selectionTitle').textContent==='已选 2 格');
  const readonlyEdits=()=>traces.filter(m=>['edit','undo','redo','copyTemplate'].includes(m.type)).length;
  const beforeFlightSelection=readonlyEdits();
  await page.evaluate(()=>{window.captureSelection=true;window.selectionPixels=0;});
  await page.locator('#scene').focus();await page.keyboard.press('f');await page.locator('#flightHelp').waitFor();
  await page.waitForFunction(()=>window.selectionPixels>10&&window.selectionVertices===144);
  assert.equal(await page.locator('.sidebar').evaluate(e=>e.inert),true);
  assert.equal(await page.locator('#tools').evaluate(e=>e.inert),true);
  for(const k of ['1','4','v','Control+c','Control+z','Enter'])await page.keyboard.press(k);
  await page.evaluate(()=>new Promise(resolve=>{
   // Wait for the host command to arrive before exiting flight.
   function seen({data}){if(data?.type==='command'&&data.cmd==='clearSelection'){window.removeEventListener('message',seen);resolve();}}
   window.addEventListener('message',seen);window.postMessage({type:'command',cmd:'clearSelection'},'*');
  }));
  assert.equal(await page.locator('#mode').textContent(),'第一人称');assert.equal(readonlyEdits(),beforeFlightSelection);
  await page.keyboard.press('Escape');await page.locator('#flightHelp').waitFor({state:'hidden'});
  assert.match(await page.locator('#selectionTitle').textContent(),/已选 2 格/);
  assert.equal(await page.locator('.sidebar').evaluate(e=>e.inert),false);
  await page.locator('[data-tool=view]').click();await page.keyboard.press('b');
  assert.match(await page.locator('#selectionTitle').textContent(),/已选 2 格/);
  await page.locator('#scene').focus();await page.keyboard.press('Control+c');await page.locator('[data-template="1"]').waitFor();
  const thumb=page.locator('[data-template="1"] canvas');
  const thumbColors=()=>thumb.evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data,colors=new Set();
   for(let i=0;i<data.length;i+=4)if(data[i+3]===255)colors.add((data[i]<<16)|(data[i+1]<<8)|data[i+2]);return colors.size;});
  assert.ok(await thumbColors()>0);
  if(assets){
   await page.waitForFunction(()=>document.querySelector('[data-template="1"] canvas').width===48);
   const textured=await thumbColors();
   await page.locator('#material').click();await page.waitForFunction(()=>document.querySelector('[data-template="1"] canvas').width===64);
   assert.ok(textured>await thumbColors(),'template must actually render original texture colors');
   await page.locator('#material').click();await page.waitForFunction(()=>document.querySelector('[data-template="1"] canvas').width===48);
   console.log('TEMPLATE_THUMB_TEXTURES_OK original textures in the sidebar, color fallback and back');
  }
  await page.locator('[data-template="1"]').click();assert.equal(await page.locator('#confirmPaste').isDisabled(),true);
  await page.keyboard.press('Enter');assert.equal(traces.filter(m=>m.type==='previewTemplate').length,0);
  await page.locator('#layer').fill('1');await page.locator('#layer').press('Tab');await page.waitForTimeout(100);
  const landing=topProj([3.5,1.015,6.5]);await page.mouse.move(landing[0],landing[1]);const beforeGhost=await page.locator('#scene').screenshot();
  await page.mouse.click(landing[0],landing[1]);await page.waitForFunction(()=>!document.querySelector('#confirmPaste').disabled);
  assert.notDeepEqual(await page.locator('#scene').screenshot(),beforeGhost);
  const beforeReadOnly=readonlyEdits();
  await page.locator('[data-tool=view]').click();await page.waitForFunction(()=>window.blueprintDrawMode==='查看');
  assert.equal(await page.locator('#confirmPaste').isDisabled(),true);
  await page.keyboard.press('Enter');assert.equal(readonlyEdits(),beforeReadOnly);
  await page.keyboard.press('b');assert.equal(await page.locator('#confirmPaste').isEnabled(),true);
  await page.keyboard.press('f');await page.locator('#flightHelp').waitFor();
  await page.waitForFunction(()=>window.blueprintDrawMode==='第一人称');
  for(const key of ['Enter','Control+y','Control+v','Delete'])await page.keyboard.press(key);
  assert.equal(readonlyEdits(),beforeReadOnly);assert.equal(await page.locator('#confirmPaste').isDisabled(),true);
  await page.keyboard.press('f');await page.locator('#flightHelp').waitFor({state:'hidden'});
  assert.equal(await page.locator('#confirmPaste').isEnabled(),true);
  console.log('READ_ONLY_OVERLAYS_OK range and blueprint stay visible in flight; switching view preserves the draft and its original placement');

  if(assets){
   await page.waitForFunction(()=>window.blueprintTextured===true);
   await page.locator('#material').click();await page.waitForFunction(()=>window.blueprintTextured===false);
   await page.locator('#material').click();await page.waitForFunction(()=>window.blueprintTextured===true);
   console.log('BLUEPRINT_TEXTURES_OK textured blueprint uses the atlas at 50% opacity and follows the color toggle');
  }

  const arrow=topProj([4+2.3,1.5,6.5]),shifted=topProj([5+2.3,1.5,6.5]);
  await page.mouse.move(...arrow);await page.mouse.down();await page.mouse.move(...shifted,{steps:4});await page.mouse.up();
  await page.locator('[data-turn="1"][data-spin="1"]').click();
  const hostUndo=()=>traces.filter(m=>m.type==='undo'||m.type==='redo').length;
  const hostBefore=hostUndo();
  await page.keyboard.press('Control+z');assert.ok(await page.locator('#redo').isEnabled());
  await page.locator('#undo').click();assert.ok(await page.locator('#undo').isDisabled());
  await page.keyboard.press('Control+y');assert.ok(await page.locator('#undo').isEnabled());
  await page.keyboard.press('Control+Shift+z');assert.ok(await page.locator('#redo').isDisabled());
  assert.equal(hostUndo(),hostBefore,'blueprint history must not go to the file history');
  assert.equal(doc.snapshot().visible,2);assert.equal(traces.filter(m=>m.type==='edit'&&m.edit.tool==='paste').length,0);
  await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#templatePlacement').hidden);
  const paste=traces.findLast(m=>m.type==='edit'&&m.edit.tool==='paste').edit;
  assert.deepEqual(paste.axes,[[0,0,-1],[0,1,0],[1,0,0]]);assert.equal(paste.origin[0],4);assert.equal(doc.snapshot().visible,4);
  assert.ok(traces.some(m=>m.type==='copyTemplate'));assert.ok(traces.some(m=>m.type==='previewTemplate'));
  await page.keyboard.press('Control+v');await page.locator('#templatePlacement').waitFor();
  await page.keyboard.press('Escape');await page.locator('#templatePlacement').waitFor({state:'hidden'});assert.equal(doc.snapshot().visible,4);
  console.log('CLIPBOARD_OK Ctrl+C thumbnail, choose-first translucent blueprint, adjust axes, Enter commits, Ctrl+V and Esc');
  doc=await Structure.open(create([10,8,10]));
  for(const [pos,name] of [[[1,1,1],'water'],[[2,1,1],'oak_log'],[[6,1,6],'glass'],[[7,1,6],'stone']])doc.edit({tool:'place',points:[pos],state:{name:'minecraft:'+name,props:{}}});
  await load();await rendered();await page.locator('#topView').click();await page.locator('#tab-tools').click();
  await page.locator('#selectFluid').check();await page.locator('#moveOverwrite').uncheck();await page.locator('[data-tool=box]').click();
  await page.locator('#cornerA').fill('1,1,1');await page.locator('#cornerB').fill('2,1,1');await page.locator('#confirmBox').click();
  await page.waitForFunction(()=>document.querySelector('#selectionTitle').textContent==='已选 2 格');
  await page.locator('#scene').focus();await page.keyboard.press('Control+c');await page.locator('[data-template="2"]').click();
  await page.locator('#layer').fill('1');await page.locator('#layer').press('Tab');await page.waitForTimeout(100);
  await page.mouse.click(...topProj([5.5,1.015,6.5]));await page.waitForFunction(()=>!document.querySelector('#confirmPaste').disabled);
  await page.locator('#ignorePasteFluids').check();await page.waitForFunction(()=>document.querySelector('#selectionTitle').textContent==='蓝图 1 格');
  await page.locator('#steps [data-axis="0"][data-step="1"]').click();
  await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('已有方块'));
  assert.equal(doc.snapshot().visible,4);await page.locator('#pasteOverwriteSettings').click();await page.locator('#moveOverwrite').check();await page.locator('#tab-templates').click();
  await page.locator('#confirmPaste').click();await page.waitForFunction(()=>document.querySelector('#templatePlacement').hidden);
  const pasteWithRules=traces.findLast(m=>m.type==='edit'&&m.edit.tool==='paste').edit;
  assert.equal(pasteWithRules.moveOverwrite,true);assert.equal(pasteWithRules.ignoreFluids,true);
  const blueprintNameAt=p=>doc.state((doc.at(doc.cell(p))>>1)-1)?.name;
  assert.equal(blueprintNameAt([6,1,6]),'minecraft:glass');assert.equal(blueprintNameAt([7,1,6]),'minecraft:oak_log');
  console.log('BLUEPRINT_RULES_OK local undo/redo, shared overwrite settings, and no placement for skipped fluid cells');
  doc=await Structure.open(create([10,6,10]));
  await load();await page.locator('[data-tool=view]').click();await page.evaluate(()=>{window.captureBounds=true;window.boundPixels=0;});await page.locator('#reset').click();
  const afterFrame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const boundsButton=page.locator('#structureBounds');assert.equal(await boundsButton.getAttribute('aria-pressed'),'false');await afterFrame();
  assert.equal(await page.evaluate(()=>window.captureBounds),true,'the empty structure should have no outline by default');
  await boundsButton.click();assert.equal(await boundsButton.getAttribute('aria-pressed'),'true');
  await page.waitForFunction(()=>window.boundColors?.every(n=>n>5)&&window.boundAlpha===.5&&window.boundBlend&&window.boundDepth&&!window.boundDepthWrite);
  assert.deepEqual(await page.evaluate(()=>window.boundStrokeColors),[1,1,1,9]);
  const openBorderPixels=await page.evaluate(()=>window.boundPixels);
  doc.edit({tool:'fill',box:[[0,0,0],[9,5,9]],state:{name:'minecraft:stone',props:{}}});await load();await rendered();
  await page.evaluate(()=>{window.captureBounds=true;});await page.locator('#reset').click();
  await page.waitForFunction(()=>!window.captureBounds);
  assert.ok(await page.evaluate(n=>window.boundPixels<n*.92,openBorderPixels),'solid faces must hide the edges behind them');
  await page.evaluate(()=>{window.captureBounds=true;});await boundsButton.click();await afterFrame();
  assert.equal(await boundsButton.getAttribute('aria-pressed'),'false');assert.equal(await page.evaluate(()=>window.captureBounds),true);
  await page.evaluate(()=>{window.captureBounds=false;});
  console.log('STRUCTURE_BOUNDARY_OK 50% outline; only the three origin edges are colored; solid blocks occlude rear edges');
  doc=await Structure.open(create([10,6,10]));await load();await rendered();
  if(assets&&maskCatalog){
   doc.edit({tool:'fill',box:[[4,0,4],[5,0,5]],state:{name:'minecraft:blackstone',props:{}}});await load();await rendered();await page.locator('#topView').click();
   await page.locator('#keyboard').click();prefs={...prefs,resource:{kind:'none'}};
   await page.evaluate(prefs=>window.postMessage({type:'prefs',prefs},'*'),prefs);await page.waitForFunction(()=>document.querySelector('#renderMode option[value=game]').disabled);
   prefs={...prefs,resource:{kind:'jar'}};await page.evaluate(prefs=>window.postMessage({type:'prefs',prefs},'*'),prefs);
   await page.waitForFunction(()=>!document.querySelector('#renderMode option[value=game]').disabled);await page.locator('#renderMode').selectOption('game');await rendered();
   const sampleGamma=g=>page.evaluate(g=>{window.captureLight=true;window.lightSample=null;const input=document.querySelector('#gameGamma');input.value=g;input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('change'));},g);
   await sampleGamma(0);await page.waitForFunction(()=>window.lightSample?.gamma===0);
   const low=await page.evaluate(()=>window.lightSample.value);
   await sampleGamma(1);await page.waitForFunction(()=>window.lightSample?.gamma===1);
   const high=await page.evaluate(()=>window.lightSample.value);assert.ok(high>low+10,`Gamma must visibly lift the blackstone: ${low} → ${high}`);
   assert.ok(traces.some(m=>m.type==='rendering'&&m.mode==='game'&&m.gamma===1));
   await page.locator('#renderMode').selectOption('smooth');assert.equal(await page.locator('#gameGamma').isDisabled(),true);
   await page.locator('#settingsClose').click();await rendered();
   console.log('GAME_RENDER_OK JAR-only setting, visible Gamma brightness change, switch back to Smooth');
  }
  doc=await Structure.open(create([10,6,10]));
  doc.edit({tool:'fill',box:[[0,2,0],[9,2,9]],state:{name:'minecraft:blackstone',props:{}}});
  await page.locator('#layerMode').selectOption('full');await load();await rendered();await page.locator('#topView').click();
  await page.locator('[data-tool=box]').click();await page.locator('#cornerA').fill('4,0,4');await page.locator('#cornerB').fill('5,0,5');
  const captureEdges=async()=>{
   await page.evaluate(()=>{window.captureSelection=true;});
   await page.locator('#cornerB').evaluate(e=>e.dispatchEvent(new Event('input')));
   await page.waitForFunction(()=>!window.captureSelection);return await page.evaluate(()=>({pixels:window.selectionPixels,depth:window.selectionDepthTest}));
  };
  const covered=await captureEdges();assert.equal(covered.depth,true);assert.equal(covered.pixels,0,'selection lines behind a solid roof must not appear through it');
  await page.locator('#layerMode').selectOption('below');await page.locator('#layer').fill('1');await page.locator('#layer').press('Tab');
  await page.waitForTimeout(100);await rendered();
  const exposed=await captureEdges();assert.equal(exposed.depth,true);assert.ok(exposed.pixels>30,'selection should be visible after the layer hides the roof');
  console.log('SELECTION_DEPTH_OK solid roof hides the same precisely projected box that is exposed in a cutaway');
  doc=await Structure.open(create([6,2,1]));
  for(const [x,name] of ['air','cave_air','void_air',null,'stone'].entries())if(name)doc.edit({tool:'fill',box:[[x,0,0],[x,0,0]],state:{name:'minecraft:'+name,props:{}}});
  await page.locator('#layerMode').selectOption('full');await load();await rendered();await page.locator('[data-tool=view]').click();
  const invisibleToggle=page.locator('#invisibleBlocks');assert.equal(await invisibleToggle.getAttribute('aria-pressed'),'false');
  await page.evaluate(()=>{window.captureMarkers=true;window.markerDraw=0;});await page.locator('#reset').click();await afterFrame();
  assert.equal(await page.evaluate(()=>window.markerDraw),0);
  await page.locator('#scene').focus();await page.keyboard.press('Tab');await page.waitForFunction(()=>window.markerDraw===11*24);
  assert.equal(await invisibleToggle.getAttribute('aria-pressed'),'true');
  await page.keyboard.press('Tab');assert.equal(await invisibleToggle.getAttribute('aria-pressed'),'false');
  await page.locator('#keyboard').focus();await page.keyboard.press('Tab');assert.equal(await invisibleToggle.getAttribute('aria-pressed'),'false');
  await page.locator('#keyboard').click();
  const invisibleKey=page.locator('#keysList').getByText('切换隐形方块显示',{exact:true}).locator('xpath=following-sibling::button[1]');
  assert.equal(await invisibleKey.textContent(),'Tab');await invisibleKey.click();await page.keyboard.press('g');
  await page.waitForFunction(()=>document.querySelector('#invisibleBlocks').getAttribute('aria-keyshortcuts')==='g');
  await page.locator('#settingsClose').click();await page.locator('#scene').focus();await page.keyboard.press('g');
  assert.equal(await invisibleToggle.getAttribute('aria-pressed'),'true');
  await page.locator('#layerMode').selectOption('single');await page.locator('#layer').fill('0');await page.locator('#layer').press('Tab');
  await page.waitForFunction(()=>window.markerDraw===5*24);
  assert.equal(await invisibleToggle.getAttribute('aria-pressed'),'true');
  await page.locator('#topView').click();await page.locator('[data-tool=erase]').click();await afterFrame();
  const markerPoint=(x,z=.5)=>page.evaluate(p=>{
   const m=window.cameraMatrix,r=document.querySelector('#scene').getBoundingClientRect();
   const dot=i=>m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12];
   return [r.left+(1+dot(0)/dot(3))*r.width/2,r.top+(1-dot(1)/dot(3))*r.height/2];
  },[x,.5,z]);
  await page.locator('[data-tool=box]').click();
  await page.mouse.dblclick(...await markerPoint(3.5));
  assert.equal(await page.locator('#cornerA').inputValue(),'3, 0, 0');assert.equal(await page.locator('#selectionTitle').textContent(),'已选 1 格');
  await page.locator('#deselect').click();
  await page.mouse.move(...await markerPoint(.5));await page.mouse.down();await page.mouse.move(...await markerPoint(3.5),{steps:6});await page.mouse.up();
  assert.equal(await page.locator('#selectionTitle').textContent(),'已选 4 格');
  await invisibleToggle.click();assert.equal(await page.locator('#selectionTitle').textContent(),'已选 0 格');
  await invisibleToggle.click();assert.equal(await page.locator('#selectionTitle').textContent(),'已选 4 格');
  await page.locator('#deselect').click();await page.mouse.dblclick(...await markerPoint(1.5));
  assert.equal(await page.locator('#cornerA').inputValue(),'1, 0, 0');
  await page.locator('[data-tool=extrude]').click();
  const axisUp=page.locator('#steps [data-axis="1"][data-step="1"]');
  assert.equal(await axisUp.isEnabled(),true);
  await invisibleToggle.click();assert.equal(await axisUp.isDisabled(),true);
  await invisibleToggle.click();assert.equal(await axisUp.isEnabled(),true);
  await page.locator('[data-tool=box]').click();
  await axisUp.click();
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);
  assert.equal(doc.state((doc.at(1)>>1)-1).name,'minecraft:air');assert.equal(doc.state((doc.at(7)>>1)-1).name,'minecraft:cave_air');
  await page.locator('#layerMode').selectOption('below');await page.locator('#layer').fill('1');await page.locator('#layer').press('Tab');
  await page.locator('#steps [data-axis="1"][data-step="-1"]').click();
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);
  assert.equal(doc.state((doc.at(1)>>1)-1).name,'minecraft:cave_air');
  await page.locator('#layerMode').selectOption('single');await page.locator('#layer').fill('0');await page.locator('#layer').press('Tab');
  await page.locator('[data-tool=erase]').click();
  const beforeMarkerStroke=traces.filter(m=>m.type==='edit').length;
  await page.waitForFunction(()=>window.markerDraw===5*24);
  await page.mouse.move(...await markerPoint(4.5));await page.mouse.down();
  await page.waitForFunction(()=>window.markerDraw===6*24);
  await page.mouse.move(...await markerPoint(2.5),{steps:5});
  assert.equal(traces.filter(m=>m.type==='edit').length,beforeMarkerStroke,'red marks should already appear without committing the stroke');
  await page.keyboard.press('Escape');await page.mouse.up();
  await page.waitForFunction(()=>window.markerDraw===5*24);
  assert.equal(doc.snapshot().visible,1);
  await page.mouse.click(...await markerPoint(.25));assert.notEqual(doc.at(0),0,'clicking outside the blue-purple marker should not erase the air cell');
  for(const x of [0,1,2]){
   await page.mouse.click(...await markerPoint(x+.5));await page.waitForFunction(()=>!document.querySelector('#save').disabled);
   assert.equal(doc.at(x),0,'erase creates an unrecorded structure void, not an explicit air record');
  }
  const erased=traces.filter(m=>m.type==='edit').at(-1).edit;assert.equal(erased.tool,'erase');assert.equal(erased.eraseInvisible,true);
  await invisibleToggle.click();
  await page.evaluate(()=>{window.markerDraw=0;});await page.locator('#reset').click();await afterFrame();
  assert.equal(await page.evaluate(()=>window.markerDraw),0);assert.equal(doc.snapshot().visible,1);
  await page.locator('#layerMode').selectOption('full');await invisibleToggle.click();
  await page.locator('#tab-tools').click();await page.locator('#resize').click();
  await page.locator('#sizeX').fill('7');await page.locator('#sizeForm button[type=submit]').click();
  await page.waitForFunction(()=>window.markerDraw===13*24);
  assert.equal(doc.state((doc.at(doc.cell([6,1,0]))>>1)-1).name,'minecraft:air');
  assert.equal(doc.at(doc.cell([0,1,0])),0);
  await page.evaluate(()=>{window.captureMarkers=false;});
  console.log('INVISIBLE_MARKERS_OK selection and axes survive toggles; resized air and original holes both visible');
  doc=await Structure.open(create([10,8,10]));
  doc.edit({tool:'place',points:[[1,0,1]],state:{name:'minecraft:stone',props:{}}});
  doc.edit({tool:'fill',box:[[1,2,1],[1,2,1]],state:{name:'minecraft:cave_air',props:{}}});
  await load();await rendered();await page.locator('#topView').click();await invisibleToggle.click();
  await page.locator('[data-tool=box]').click();
  await page.locator('#cornerA').fill('0,0,0');await page.locator('#cornerB').fill('2,2,2');await page.locator('#confirmBox').click();
  assert.equal(await invisibleToggle.getAttribute('aria-pressed'),'false');
  const nextId=clips.size+1;await page.locator('#scene').focus();await page.keyboard.press('Control+c');
  const newTemplate=page.locator(`[data-template="${nextId}"]`);await newTemplate.waitFor();
  assert.deepEqual(clips.get(nextId).size,[3,3,3]);assert.equal(clips.get(nextId).blocks.length,2);
  const smallPreview=newTemplate.locator('canvas');
  if(assets)await page.waitForFunction(id=>document.querySelector(`[data-template="${id}"] canvas`).width===48,nextId);
  const hiddenImage=await smallPreview.evaluate(c=>c.toDataURL());
  await page.locator('#templateShowInvisible').check();
  await page.waitForFunction(([id,old])=>document.querySelector(`[data-template="${id}"] canvas`).toDataURL()!==old,[nextId,hiddenImage]);
  await page.locator('#templateShowInvisible').uncheck();
  await page.getByRole('button',{name:`保存 模板 ${nextId} 为 NBT`}).click();
  assert.equal(traces.at(-1).type,'saveTemplate');
  await newTemplate.click();assert.equal(await page.locator('#pasteAnchor').inputValue(),'center');
  await page.mouse.click(...await markerPoint(6.5,6.5));await page.locator('#confirmPaste').click();
  await page.waitForFunction(()=>document.querySelector('#templatePlacement').hidden);
  assert.deepEqual(traces.findLast(m=>m.type==='edit'&&m.edit.tool==='paste').edit.origin,[5,0,5]);
  assert.equal(doc.state((doc.at(doc.cell([6,2,6]))>>1)-1).name,'minecraft:cave_air');
  await newTemplate.click();await page.mouse.click(...await markerPoint(5.5,2.5));await page.locator('#pasteAnchor').selectOption('corner');
  await page.locator('#confirmPaste').click();await page.waitForFunction(()=>document.querySelector('#templatePlacement').hidden);
  assert.deepEqual(traces.findLast(m=>m.type==='edit'&&m.edit.tool==='paste').edit.origin,[5,0,2]);
  console.log('TEMPLATE_ANCHORS_OK center/corner, hidden layer copy, thumbnail toggle, save action');
  doc=await Structure.open(create([10,8,10]));
  doc=await Structure.open(doc.layout({kind:'entity',action:'add',id:'minecraft:allay',summoned:Buffer.from([10,0,0,8,0,2,105,100,0,15,...Buffer.from('minecraft:allay'),0]),pos:[4.5,1,4.5],palette:0}).raw);
  const entityInfo=doc.entityDetails(0);
  doc=await Structure.open(doc.layout({kind:'entity',action:'nbt',index:0,revision:entityInfo.revision,palette:0,
   text:'{id:"minecraft:allay",Rotation:[0f,27f],NoGravity:1b,Brain:{memories:{}},HurtByTimestamp:0,listener:{},Invulnerable:0b,FallFlying:0b,PortalCooldown:0,AbsorptionAmount:0f,FallDistance:0f,DuplicationCooldown:0L,DeathTime:0s,HandDropChances:[0.085f,0.085f],PersistenceRequired:0b,LongFieldNameThatDoesNotFitInTheDefaultSidebarWidth:1}'}).raw);
  await load();await page.locator('#tab-entities').click();await page.locator('#entityList').selectOption('0');
  const entityPick=page.locator('#entityPickPos'),entityPos=page.locator('#entityPos');
  await page.locator('[data-tool=erase]').click();await entityPick.click();
  assert.equal(await page.locator('#mode').textContent(),'取样');
  assert.equal(await page.locator('[data-tool=pick]').getAttribute('aria-pressed'),'true');
  assert.equal(await entityPick.getAttribute('aria-pressed'),'true');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#mode').textContent(),'擦除');
  assert.equal(await entityPick.getAttribute('aria-pressed'),'false');
  await entityPick.click();await page.locator('#topView').click();await afterFrame();
  await page.mouse.click(...await markerPoint(6.5,6.5));
  assert.equal(await entityPos.inputValue(),'6.5, 0, 6.5');
  assert.equal(await page.locator('#mode').textContent(),'擦除');assert.equal(await entityPick.getAttribute('aria-pressed'),'false');
  console.log('ENTITY_POSITION_PICK_OK: auto-switch, Esc cancel, coordinate capture, previous tool restored');
  await page.locator('[data-tool=view]').click();await page.locator('#reset').click();await afterFrame();
  const screenPoint=point=>page.evaluate(p=>{
   const m=window.cameraMatrix,r=document.querySelector('#scene').getBoundingClientRect(),v=i=>m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12];
   return [r.left+(1+v(0)/v(3))*r.width/2,r.top+(1-v(1)/v(3))*r.height/2];
  },point);
  await page.evaluate(()=>{
   const status=document.querySelector('#message');window.entityPreviewRebuilt=false;
   window.watchEntityPreview=new MutationObserver(()=>{if(status.textContent.includes('正在生成预览'))window.entityPreviewRebuilt=true;});
   window.watchEntityPreview.observe(status,{subtree:true,childList:true,characterData:true});
  });
  const origin=[4.5,1,4.5],center=pos=>[pos[0],pos[1]+.55,pos[2]];
  const gizmoSpan=(p,top)=>{
   const t=top?1.565:.47,y=top?0:.70,d=Math.hypot(10,8,10)*1.07;
   const eye=[5+d*Math.sin(y)*Math.cos(t),3.84+d*Math.sin(t),5+d*Math.cos(y)*Math.cos(t)];
   return Math.hypot(...p.map((v,i)=>v-eye[i]))*.14;
  };
  const o=center(origin),span=gizmoSpan(o,false),tip=await screenPoint([o[0]+span,o[1],o[2]]),tipPlus=await screenPoint([o[0]+span+1,o[1],o[2]]);
  const dragArrow=async()=>{await page.mouse.move(...tip);await page.mouse.down();await page.mouse.move(...tipPlus,{steps:4});await page.waitForFunction(()=>document.querySelector('#coords').textContent.startsWith('实体位置：'));};
  await dragArrow();await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(doc.entityList()[0].pos,origin);
  await dragArrow();assert.deepEqual(doc.entityList()[0].pos,origin);await page.mouse.up();
  const moved=[5.5,1,4.5];await page.waitForFunction(()=>document.querySelector('#entityPos').value==='5.5, 1, 4.5');assert.deepEqual(doc.entityList()[0].pos,moved);
  await page.locator('#topView').click();await afterFrame();
  const pivot=center(moved),radius=gizmoSpan(pivot,true)*1.4;
  const ringPoint=a=>screenPoint([pivot[0]+radius*Math.sin(a),pivot[1],pivot[2]+radius*Math.cos(a)]);
  const startAngle=Math.PI/6;await page.mouse.move(...await ringPoint(startAngle));await page.mouse.down();
  for(let i=1;i<=8;i++)await page.mouse.move(...await ringPoint(startAngle+i*Math.PI/16));
  await page.waitForFunction(()=>document.querySelector('#coords').textContent.includes('朝向 -90°'));
  assert.deepEqual(doc.entityList()[0].rotation,[0,27]);await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('#entitySnbt').value.includes('"Rotation":[-90f,27f]'));
  assert.deepEqual(doc.entityList()[0].rotation,[-90,27]);assert.deepEqual(doc.entityList()[0].pos,moved);
  await page.locator('#reset').click();await afterFrame();
  const oldRadius=gizmoSpan(pivot,false)*1.4;
  const oldPitchRing=a=>screenPoint([pivot[0]+oldRadius*Math.sin(a),pivot[1]+oldRadius*Math.cos(a),pivot[2]]);
  const noPitchRequest=traces.length;
  await page.mouse.move(...await oldPitchRing(startAngle));await page.mouse.down();await page.mouse.move(...await oldPitchRing(startAngle+.5));await page.mouse.up();
  assert.equal(traces.slice(noPitchRequest).some(m=>m.type==='layout'&&m.layout.kind==='entity'),false);
  assert.equal(await page.evaluate(()=>{window.watchEntityPreview.disconnect();return window.entityPreviewRebuilt;}),false);
  console.log('ENTITY_TRANSFORM_UI_OK axis drag, live draft, Esc cancellation, Y-only rotation preserves original pitch');
  const nbts=page.locator('#entityForm .entity-nbt-line'),longName='LongFieldNameThatDoesNotFitInTheDefaultSidebarWidth';
  await page.locator('#entityForm input[aria-label="'+longName+'"]').waitFor();
  const toggle=page.locator('#entityForm').getByRole('combobox',{name:'NoGravity',exact:true});
  assert.deepEqual(await toggle.locator('option').allTextContents(),['0b','1b']);
  assert.equal(await toggle.inputValue(),'1b');await toggle.selectOption({label:'0b'});
  await page.locator('#entityApply').click();await page.waitForFunction(()=>document.querySelector('#entitySnbt').value.includes('"NoGravity":0b'));
  assert.match(doc.entityDetails(0).text,/"NoGravity":0b/);
  const nbtMenu=page.locator('.nbt-completion:popover-open');
  const selectNbtHint=async label=>{await nbtMenu.getByRole('option',{name:label,exact:true}).click();};
  const typeAt=async (control,text)=>{const cursor=text.indexOf('|');await control.fill(text.replace('|',''));await control.evaluate((input,i)=>input.setSelectionRange(i,i),cursor);await control.press('Control+Space');};
  const addField=under=>under.getByRole('combobox',{name:'可添加字段',exact:true});
  const addRoot=page.locator('#entityForm > .entity-nbt-add');await addRoot.locator('summary').click();
  await addField(addRoot).selectOption('attributes');
  const attributes=page.locator('#entityForm > details').filter({has:page.locator('summary').getByText('attributes',{exact:true})});
  await attributes.getByRole('button',{name:'添加列表条目',exact:true}).click();
  const entry=attributes.locator('details.entity-nbt-branch').last();
  const addEntry=entry.locator('.entity-nbt-add');await addEntry.locator('summary').click();
  await addField(addEntry).selectOption('id');
  const attributeId=entry.getByRole('textbox',{name:/attributes \/ \d+ \/ id/});await attributeId.fill('armor');await selectNbtHint('minecraft:armor');
  await attributes.getByRole('button',{name:'添加列表条目',exact:true}).click();
  await attributes.getByRole('button',{name:'上移列表条目',exact:true}).last().click();
  const entries=attributes.locator('.entity-nbt-line').filter({has:page.getByRole('button',{name:'移除 0',exact:true})});
  await entries.getByRole('button',{name:'移除 0',exact:true}).click();
  await page.locator('#entityApply').click();await page.waitForFunction(()=>document.querySelector('#entitySnbt').value.includes('minecraft:armor'));
  assert.match(doc.entityDetails(0).text,/"attributes":\[\{"id":"minecraft:armor"\}\]/);
  await page.locator('#entityEditor summary').getByText('SNBT 源码',{exact:true}).click();
  const snbt=page.locator('#entitySnbt'),originalSnbt=await snbt.inputValue();
  await typeAt(snbt,'{id:"minecraft:allay",active_effects:[{id:"spe|"}]}');await selectNbtHint('minecraft:speed');
  assert.match(await snbt.inputValue(),/minecraft:speed/);await snbt.fill(originalSnbt);
  await page.locator('#snbtMode').click();const full=page.locator('#snbtText');await full.waitFor();await page.waitForFunction(()=>!document.querySelector('#snbtText').readOnly);
  await typeAt(full,'{blocks:[{nbt:{id:"minecraft:trial_spawner",spawn_data:{entity:{id:"minecraft:breeze",active_effects:[{dur|}]}}}}]}');
  await selectNbtHint('duration');assert.match(await full.inputValue(),/duration: /);
  await page.locator('#snbtClose').click();
  console.log('NBT_COMPLETION_UI_OK typed fields, nested lists, registry IDs, and full structure SNBT');
  const metrics=await nbts.evaluateAll(rows=>rows.filter(r=>r.offsetHeight>0).map(r=>[r.getBoundingClientRect().height,getComputedStyle(r).borderRadius]));
  assert.ok(metrics.length>=10&&metrics.every(([h])=>h<=31),JSON.stringify(metrics));
  const label=page.locator('#entityForm .entity-nbt-name').getByText(longName,{exact:true});
  assert.equal(await label.getAttribute('title'),longName);assert.equal(await label.evaluate(e=>getComputedStyle(e).textOverflow),'ellipsis');
  if(process.env.VOXEL_COMPACT_NBT_SCREENSHOT){
   await page.locator('#entityEditor').scrollIntoViewIfNeeded();await page.locator('.sidebar').screenshot({path:process.env.VOXEL_COMPACT_NBT_SCREENSHOT});
  }
  await page.locator('#entityForm summary').filter({hasText:'Brain'}).click();await page.locator('#entityForm summary').filter({hasText:'memories'}).waitFor();
  const dimensionsSaved=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('voxelState')).sidebarSize);
  await page.setViewportSize({width:1190,height:740});
  await page.reload();await page.waitForFunction(()=>document.querySelector('#sidebarSplitter').getAttribute('aria-orientation')==='vertical');
  assert.ok(Math.abs((await sidebarBox()).width-dimensionsSaved.width)<2);
  await page.setViewportSize({width:440,height:740});await page.waitForFunction(()=>document.querySelector('#sidebarSplitter').getAttribute('aria-orientation')==='horizontal');
  assert.ok(Math.abs((await sidebarBox()).height-dimensionsSaved.height)<2);
  await page.setViewportSize({width:1190,height:740});
  console.log('RESIZABLE_SIDEBAR_OK mouse, keyboard, stacked sizing, reload persistence, compact typed NBT rows and nested fields');
  await page.evaluate(({prefs,catalog})=>{
   window.postMessage({type:'prefs',prefs:{...prefs,resource:{kind:'jar'}}},'*');window.postMessage({type:'collisionShapes',catalog},'*');
  },{prefs,catalog:collisions??{blocks:{'minecraft:stone':0},shapes:[[0,0,0,1,1,1]]}});
  doc.edit({tool:'place',points:[[4,1,4]],state:{name:'minecraft:stone',props:{}}});await load();await rendered();
  await page.locator('[data-tool=box]').click();
  const turnButton=axis=>page.locator(`[data-turn="${axis}"][data-spin="1"]`);
  const box=async(a,b)=>{await page.locator('#cornerA').fill(a);await page.locator('#cornerB').fill(b);await page.locator('#confirmBox').click();};
  const include=page.locator('#boxIncludeEntities'),forward=page.locator('#steps [data-axis="0"][data-step="1"]');
  assert.equal(await include.isChecked(),false);
  await box('4,1,4','5,1,4');assert.equal(await turnButton(0).isEnabled(),true);
  await include.check();assert.equal(await turnButton(0).isDisabled(),true);
  assert.equal(await turnButton(2).isDisabled(),true);assert.equal(await turnButton(1).isEnabled(),true);
  assert.match(await page.locator('#selectionTitle').textContent(),/1 实体/);
  const renderEntities=page.locator('#renderEntities');
  await page.locator('#tab-entities').click();await renderEntities.uncheck();await page.locator('[data-tool=box]').click();
  assert.equal(await include.isDisabled(),true);assert.equal(await turnButton(0).isEnabled(),true);
  await page.locator('#deselect').click();await box('4,1,4','5,1,4');
  assert.equal(await page.locator('#selectionTitle').textContent(),'已选 1 格');
  const hiddenId=clips.size+1;await page.locator('#scene').focus();await page.keyboard.press('Control+c');await page.locator(`[data-template="${hiddenId}"]`).waitFor();
  assert.equal(clips.get(hiddenId).entities.length,0);
  await page.locator('#tab-entities').click();await renderEntities.check();await page.locator('[data-tool=box]').click();
  assert.equal(await include.isEnabled(),true);assert.equal(await turnButton(0).isEnabled(),true);
  await page.locator('#deselect').click();await box('4,1,4','5,1,4');
  assert.match(await page.locator('#selectionTitle').textContent(),/1 实体/);
  console.log('HIDDEN_ENTITY_BOX_UI_OK hiding drops the entity selection and blocks copy; re-enabling requires reselecting');
  await box('4,1,4','4,1,4');await forward.click();
  await page.waitForFunction(()=>document.querySelector('#cornerA').value==='5, 1, 4'&&!document.querySelector('#save').disabled);
  assert.equal(await turnButton(0).isEnabled(),true);assert.equal(await turnButton(2).isEnabled(),true);
  assert.deepEqual(doc.entityList()[0].pos,[5.5,1,4.5]);
  const blockId=clips.size+1;await page.locator('#scene').focus();await page.keyboard.press('Control+c');await page.locator(`[data-template="${blockId}"]`).waitFor();
  assert.equal(clips.get(blockId).entities.length,0);
  await box('5,1,4','6,1,4');await forward.click();
  await page.waitForFunction(()=>document.querySelector('#cornerA').value==='6, 1, 4'&&!document.querySelector('#save').disabled);
  assert.deepEqual(doc.entityList()[0].pos,[6.5,1,4.5]);assert.equal(await turnButton(0).isDisabled(),true);
  const mixedId=clips.size+1;await page.locator('#scene').focus();await page.keyboard.press('Control+c');
  await page.locator(`[data-template="${mixedId}"]`).click();assert.equal(clips.get(mixedId).entities.length,1);await page.locator('#topView').click();await afterFrame();
  await page.mouse.click(...await markerPoint(7.5,7.5));await page.waitForFunction(()=>!document.querySelector('#confirmPaste').disabled);
  assert.equal(await turnButton(0).isDisabled(),true);assert.equal(await turnButton(2).isDisabled(),true);assert.equal(await turnButton(1).isEnabled(),true);
  await page.locator('#cancelPaste').click();
  console.log('BOX_ENTITY_SWITCH_UI_OK moved block-only selection never picks up destination entity; explicit selection moves/copies entity without a prompt');
  doc=await Structure.open(create([10,8,10]));
  for(const [pos,name] of [[[5,3,5],'moss_carpet'],[[4,3,4],'mud_bricks']])doc.edit({tool:'place',points:[pos],state:{name:'minecraft:'+name,props:{}}});
  await page.locator('#layerMode').selectOption('full');await load();await rendered();await page.locator('#reset').click();
  await page.locator('#keyboard').click();assert.equal(await page.locator('[data-resource=folder], [data-intro-resource=folder]').count(),0);await page.locator('#settingsClose').click();
  const beforeCollisionPrefs=prefs;
  await page.evaluate(({prefs,catalog})=>{
   window.postMessage({type:'prefs',prefs:{...prefs,resource:{kind:'jar'}}},'*');
   window.postMessage({type:'collisionShapes',catalog},'*');
  },{prefs,catalog:collisions??{blocks:{'minecraft:moss_carpet':0,'minecraft:mud_bricks':1,'minecraft:stone':1,'minecraft:grass_block':1,'minecraft:torchflower':2},shapes:[[0,0,0,1,1/16,1],[0,0,0,1,1,1],[.3125,0,.3125,.6875,.625,.6875]]}});
  await page.waitForFunction(()=>document.querySelector('[data-tool=pick]').title.includes('按原版碰撞箱或方块轮廓'));
  await page.locator('[data-tool=pick]').click();
  const pickScene=await page.locator('#scene').boundingBox();await page.mouse.click(pickScene.x+pickScene.width/2,pickScene.y+pickScene.height/2);
  await page.waitForFunction(()=>document.querySelector('#stateSummary').textContent==='4, 3, 4 · minecraft:mud_bricks');
  await page.locator('#topView').click();await afterFrame();
  await page.mouse.click(...await markerPoint(5.5,5.5));
  await page.waitForFunction(()=>document.querySelector('#stateSummary').textContent==='5, 3, 5 · minecraft:moss_carpet');
  await page.locator('#reset').click();await afterFrame();
  const centerPick=()=>page.mouse.click(pickScene.x+pickScene.width/2,pickScene.y+pickScene.height/2);
  const mud=[4,3,4],moss=[5,3,5],nativeNeighbor=p=>p.every((v,i)=>Number.isInteger(v)&&Math.abs(v-mud[i])<=1)&&p.reduce((n,v,i)=>n+Math.abs(v-mud[i]),0)===1;
  await page.locator('[data-tool=extrude]').click();await centerPick();
  await page.waitForFunction(()=>document.querySelector('#selectionTitle').textContent==='已选 1 格');
  await page.locator('[data-tool=box]').click();
  assert.equal(await page.locator('#cornerA').inputValue(),'4, 3, 4');
  await page.locator('#deselect').click();await page.mouse.dblclick(pickScene.x+pickScene.width/2,pickScene.y+pickScene.height/2);
  assert.equal(await page.locator('#cornerA').inputValue(),'4, 3, 4');
  await page.locator('#scene').focus();const clipId=clips.size+1;await page.keyboard.press('Control+c');
  await page.locator(`[data-template="${clipId}"]`).click();await afterFrame();
  await centerPick();await page.waitForFunction(()=>!document.querySelector('#confirmPaste').disabled,null,{timeout:3500}).catch(async e=>{
   throw new Error([e.message,JSON.stringify(traces.slice(-5)),await page.locator('#message').textContent(),await page.locator('#coords').textContent(),await page.locator('#templateHelp').textContent(),await page.locator('#mode').textContent()].join(' | '));
  });
  await page.locator('#confirmPaste').click();await page.waitForFunction(()=>document.querySelector('#templatePlacement').hidden);
  const pastedAt=traces.findLast(m=>m.type==='edit'&&m.edit.tool==='paste').edit.origin;
  assert.ok(nativeNeighbor(pastedAt));doc.edit({tool:'erase',points:[pastedAt]});await load();await rendered();
  await page.locator('#tab-entities').click();await page.locator('#entityPickPos').click();await centerPick();
  const landed=(await page.locator('#entityPos').inputValue()).split(',').map(Number).map(Math.floor);
  assert.deepEqual(landed,pastedAt);
  await page.locator('[data-tool=place]').click();await page.locator('#name').fill('minecraft:stone');await page.locator('#name').press('Escape');
  const brushDone=async tool=>{
   const count=traces.length;await centerPick();
   for(let i=0;i<100&&!traces.slice(count).some(m=>m.type==='edit'&&m.edit.tool===tool);i++)await page.waitForTimeout(20);
   const sent=traces.slice(count).find(m=>m.type==='edit'&&m.edit.tool===tool);assert.ok(sent,tool);return sent.edit.points;
  };
  assert.deepEqual(await brushDone('place'),[pastedAt]);doc.edit({tool:'erase',points:[pastedAt]});await load();await rendered();
  await page.locator('[data-tool=paint]').click();await page.locator('#name').fill('minecraft:stone');await page.locator('#name').press('Escape');
  assert.deepEqual(await brushDone('paint'),[mud]);assert.equal(blueprintNameAt(mud),'minecraft:stone');assert.equal(blueprintNameAt(moss),'minecraft:moss_carpet');
  await page.locator('[data-tool=erase]').click();assert.deepEqual(await brushDone('erase'),[mud]);
  assert.equal(blueprintNameAt(mud),undefined);assert.equal(blueprintNameAt(moss),'minecraft:moss_carpet');
  doc=await Structure.open(create([6,5,6]));
  for(const [pos,name] of [[[2,0,2],'grass_block'],[[2,1,2],'torchflower'],[[3,0,2],'grass_block'],[[3,1,2],'light']])
   doc.edit({tool:'place',points:[pos],state:{name:'minecraft:'+name,props:{}}});
  await load();await rendered();await page.locator('#topView').click();await afterFrame();
  await page.locator('[data-tool=pick]').click();
  await page.mouse.click(...await screenPoint([2.5,1.34,2.5]));
  await page.waitForFunction(()=>document.querySelector('#stateSummary').textContent==='2, 1, 2 · minecraft:torchflower');
  await page.mouse.click(...await screenPoint([2.84,1.34,2.84]));
  await page.waitForFunction(()=>document.querySelector('#stateSummary').textContent==='2, 0, 2 · minecraft:grass_block');
  await page.mouse.click(...await screenPoint([3.5,1.5,2.5]));
  await page.waitForFunction(()=>document.querySelector('#stateSummary').textContent==='3, 1, 2 · minecraft:light');
  await page.locator('[data-tool=erase]').click();await page.mouse.click(...await screenPoint([2.5,1.34,2.5]));
  await page.waitForFunction(()=>document.querySelector('#stats').textContent.startsWith('3 可见方块'));
  assert.equal(blueprintNameAt([2,1,2]),undefined);assert.equal(blueprintNameAt([2,0,2]),'minecraft:grass_block');
  console.log('NON_COLLIDABLE_PICK_UI_OK plant center picks plant, empty corner picks ground, light is selectable and erase only affects plant');
  await page.evaluate(prefs=>window.postMessage({type:'prefs',prefs},'*'),beforeCollisionPrefs);
  console.log('COLLISION_PICK_UI_OK shared geometry for sampling, painting, erasing, extrude/box selection, placement, entity position and blueprint placement');
  const command=page.locator('#structureCommand');
  doc=await Structure.open(create([10,8,10]));doc.edit({tool:'fill',box:[[4,1,4],[5,1,4]],state:{name:'minecraft:stone',props:{}}});
  await load();await rendered();await page.locator('#topView').click();await afterFrame();
  await page.locator('[data-tool=pick]').click();await page.mouse.click(...await screenPoint([4.5,1.6,4.5]));await page.waitForFunction(()=>document.querySelector('#stateSummary').textContent.startsWith('4, 1, 4'));
  await page.locator('#scene').focus();await page.keyboard.press('/');assert.equal(await command.inputValue(),'/');
  await command.fill('/setb');await command.press('Tab');assert.equal(await command.inputValue(),'/setblock ');
  await command.press('Tab');assert.equal(await command.inputValue(),'/setblock 4 1 4 ');
  await command.fill('/setblock 4 1 4 minecraft:oak_log[');await command.press('Tab');assert.match(await command.inputValue(),/axis=$/);
  await command.fill('/setblock 4 1 4 minecraft:oak_log[axis=z]');await command.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);assert.equal(doc.state((doc.at(doc.cell([4,1,4]))>>1)-1).props.axis,'z');assert.equal(await command.inputValue(),'');
  await page.locator('[data-tool=box]').click();await page.locator('#cornerA').fill('4,1,4');await page.locator('#cornerB').fill('5,1,4');await page.locator('#confirmBox').click();
  await command.fill('/fill ');await command.press('Tab');assert.equal(await command.inputValue(),'/fill 4 1 4 5 1 4 ');
  await command.fill((await command.inputValue())+'minecraft:gold_block');await command.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);assert.equal(blueprintNameAt([5,1,4]),'minecraft:gold_block');assert.equal(await command.inputValue(),'');
  const takeCommand=page.locator('#commandPick'),commandHelp=page.locator('#commandHelp');
  const coordinatesAre=text=>page.waitForFunction(want=>document.querySelector('#coords').textContent===want,text);
  await command.fill('/setblock ');await takeCommand.click();
  assert.equal(await page.locator('#mode').textContent(),'取坐标');
  assert.match(await commandHelp.textContent(),/Alt/);
  assert.equal(await page.locator('#apply').isDisabled(),true);
  assert.equal(await page.locator('#steps [data-axis]').first().isDisabled(),true);
  await page.evaluate(()=>{window.watchCoordinateOutline=true;});
  const topFace=await screenPoint([4.5,2,4.5]);await page.mouse.move(...topFace);
  await coordinatesAre('4, 1, 4');await page.waitForFunction(()=>window.coordinateOutlines>0);
  await page.keyboard.down('Alt');await coordinatesAre('4, 2, 4');
  await page.keyboard.up('Alt');await coordinatesAre('4, 1, 4');
  await page.keyboard.down('Alt');await page.mouse.click(...topFace);await page.keyboard.up('Alt');
  assert.equal(await command.inputValue(),'/setblock 4 2 4 ');
  await command.fill('/setblock ');await takeCommand.click();await page.locator('[data-tool=box]').click();
  assert.equal(await takeCommand.getAttribute('aria-pressed'),'false','choosing the current tool must exit coordinate picking');
  assert.equal(await page.locator('#apply').isEnabled(),true);
  await command.fill('/fill ');await takeCommand.click();await page.keyboard.press('2');
  assert.equal(await takeCommand.getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('[data-tool=place]').getAttribute('aria-pressed'),'true');
  assert.equal(await command.inputValue(),'/fill ');
  await page.locator('[data-tool=view]').click();await page.locator('#reset').click();await afterFrame();
  const canvasRect=await page.locator('#scene').boundingBox(),cx=canvasRect.x+canvasRect.width*.42,cy=canvasRect.y+canvasRect.height*.50;
  await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.move(cx+240,cy,{steps:4});await page.mouse.up();await afterFrame();
  const westFace=await screenPoint([4,1.5,4.5]);await command.fill('/setblock ');await takeCommand.click();
  await page.mouse.move(...westFace);await coordinatesAre('4, 1, 4');
  await page.keyboard.down('Alt');await coordinatesAre('3, 1, 4');await page.mouse.click(...westFace);await page.keyboard.up('Alt');
  assert.equal(await command.inputValue(),'/setblock 3 1 4 ');
  await page.locator('#topView').click();await afterFrame();
  await page.locator('[data-tool=erase]').click();
  const firstCorner=await screenPoint([4.5,1.6,4.5]),secondCorner=await screenPoint([5.5,1.6,4.5]);
  const beforeCommandPick=traces.filter(m=>m.type==='edit').length;
  await command.fill('/fill ');await takeCommand.click();assert.match(await commandHelp.textContent(),/第一角/);
  await page.mouse.click(...firstCorner);assert.equal(await command.inputValue(),'/fill 4 1 4 ');
  assert.match(await commandHelp.textContent(),/第二角/);assert.equal(await takeCommand.getAttribute('aria-pressed'),'true');
  await page.mouse.click(...secondCorner);assert.equal(await command.inputValue(),'/fill 4 1 4 5 1 4 ');
  assert.equal(await takeCommand.getAttribute('aria-pressed'),'false');
  const draft='/fill 0 0 0 1 1 1 minecraft:stone outline';await command.fill(draft);
  await command.evaluate(e=>e.setSelectionRange(6,6));await command.press('Control+Space');
  await page.getByRole('option',{name:'到画布取坐标…',exact:true}).click();
  await page.mouse.click(...firstCorner);await command.press('Escape');
  assert.equal(await takeCommand.getAttribute('aria-pressed'),'false');
  assert.equal(await command.inputValue(),'/fill 4 1 4 1 1 1 minecraft:stone outline');
  await takeCommand.click();await page.mouse.click(...secondCorner);
  assert.equal(await command.inputValue(),'/fill 4 1 4 5 1 4 minecraft:stone outline');
  assert.equal(await takeCommand.getAttribute('aria-pressed'),'false');
  assert.equal(traces.filter(m=>m.type==='edit').length,beforeCommandPick,'neither pick may activate the eraser');
  await command.fill('/setblock ');await takeCommand.click();
  await page.mouse.click(...await screenPoint([5.5,1.6,4.5]));assert.equal(await command.inputValue(),'/setblock 5 1 4 ');
  assert.equal(blueprintNameAt([5,1,4]),'minecraft:gold_block','sampling must not use the active erase tool');
  await page.mouse.click(...await screenPoint([5.5,1.6,4.5]));
  await page.waitForFunction(()=>!document.querySelector('#save').disabled&&document.querySelector('#stats').textContent.startsWith('1 可见方块'));
  assert.equal(await command.inputValue(),'/setblock 5 1 4 ','a regular edit must keep the command draft');
  await page.evaluate(({prefs,catalog})=>{window.postMessage({type:'prefs',prefs:{...prefs,resource:{kind:'jar'}}},'*');window.postMessage({type:'collisionShapes',catalog},'*');},
   {prefs,catalog:collisions??{blocks:{'minecraft:gold_block':0},shapes:[[0,0,0,1,1,1]]}});
  await command.fill('/summon pig');await command.press('Tab');assert.match(await command.inputValue(),/^\/summon minecraft:pig /);
  await command.fill('/summon minecraft:pig 2.5 1 3.5 {NoA}');
  await command.evaluate(e=>{const i=e.value.indexOf('}');e.setSelectionRange(i,i);});await command.press('Tab');assert.match(await command.inputValue(),/NoAI:\s*[01]b/);
  await command.fill('/summon minecraft:pig 2.5 1 3.5 {NoAI:1b,Tags:["from console"]}');await command.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#stats').textContent.includes('1 实体'));
  assert.deepEqual(doc.entityList()[0].pos,[2.5,1,3.5]);if(maskJar)assert.match(doc.entityDetails(0).text,/from console/);
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);assert.equal(await command.inputValue(),'');
  await command.fill('/setblock 0 0 0 chest[facing=west]{CustomName:"Command Chest"}');await command.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);assert.equal(await command.inputValue(),'');
  assert.equal(doc.tileValue(doc.cell([0,0,0]),'CustomName').text,'"Command Chest"');
  await command.fill('/fill 0 0 0 2 2 2 minecraft:quartz_block hol');await command.press('Tab');assert.match(await command.inputValue(),/hollow $/);
  await command.fill('/fill 6 0 6 8 2 8 minecraft:quartz_block hollow');await command.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);assert.equal(await command.inputValue(),'');
  assert.equal(blueprintNameAt([7,1,7]),'minecraft:air');assert.equal(blueprintNameAt([8,1,7]),'minecraft:quartz_block');
  if(maskCatalog){
   await page.evaluate(catalog=>window.postMessage({type:'maskCatalog',catalog},'*'),maskCatalog);
   await command.fill('/fill 4 1 4 4 1 4 minecraft:oak_log[axis=z]');await command.press('Enter');
   await page.waitForFunction(()=>!document.querySelector('#save').disabled);
   await command.fill('/fill 4 1 4 4 1 4 minecraft:glass replace #minecraft:logs[axis=z] strict');await command.press('Enter');
   await page.waitForFunction(()=>!document.querySelector('#save').disabled);assert.equal(await command.inputValue(),'');
   assert.equal(blueprintNameAt([4,1,4]),'minecraft:glass');
  }
  doc=await Structure.open(create([65,65,65]));await load();await rendered();
  const tooLarge='/fill 0 0 0 64 64 64 minecraft:stone';await command.fill(tooLarge);await command.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('选区过大'));
  assert.equal(await command.inputValue(),tooLarge,'a rejected edit must keep the command text');
  console.log('STRUCTURE_COMMAND_UI_OK Tab, green coordinate outline, Alt top/west offset, tool lock and exit, consecutive corners, state and NBT completion, protected coordinate sampling, edits, summon, clear on success and keep on failure');
  await page.clock.install();
  const message=page.locator('#message');
  const tell=(type,text)=>page.evaluate(([type,message])=>window.postMessage({type,message},'*'),[type,text]);
  await tell('error','目标位置有未选中的方块');await message.waitFor({state:'visible'});assert.match(await message.textContent(),/未选中/);
  await page.clock.runFor(2500);await tell('error','目标位置有未选中的方块');await message.waitFor({state:'visible'});
  await page.clock.runFor(1700);assert.equal(await message.textContent(),'');
  await tell('info','保护了 1 个含 NBT 的方块');await message.waitFor({state:'visible'});await page.clock.runFor(4100);assert.equal(await message.textContent(),'');
  await tell('fatal','无法打开结构 NBT');await message.waitFor({state:'visible'});await page.clock.runFor(5000);assert.equal(await message.textContent(),'无法打开结构 NBT');
  console.log('NOTICE_TIMEOUT_OK: recoverable errors and warnings clear, duplicates do not extend, fatal stays');
  console.log('WEBVIEW_SMOKE_OK: textures, layers, pick, fill, axis dragging, extrusion, erase');assert.equal(errs.length,0,errs.join('\n'));
 }finally{await require('../lib/native-summon').stopSummon();if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
