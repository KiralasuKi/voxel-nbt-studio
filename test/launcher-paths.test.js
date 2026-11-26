'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {librariesRoots,addHint}=require('../lib/paths');

test('discover shared launcher dependencies beside the selected JAR or from a workspace hint',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'voxel_paths_'));
 try{
  const libraries=path.join(root,'PrismLauncher','libraries');
  await Promise.all(['com/mojang','com/google'].map(p=>fs.mkdir(path.join(libraries,p),{recursive:true})));
  const instance=path.join(root,'PrismLauncher','instances','test','.minecraft');
  const jar=path.join(instance,'versions','1.21','1.21.jar');
  await fs.mkdir(path.dirname(jar),{recursive:true});
  assert.ok(librariesRoots(jar).includes(libraries));
  addHint(instance);
  assert.ok(librariesRoots(path.join(root,'detached','1.21.jar')).includes(libraries));
 }finally{
  const target=path.resolve(root);
  if(path.dirname(target)===path.resolve(os.tmpdir())&&path.basename(target).startsWith('voxel_paths_'))await fs.rm(target,{recursive:true,force:true});
 }
});
