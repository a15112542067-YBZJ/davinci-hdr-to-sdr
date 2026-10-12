const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function harness({failImport=false,existing=false,rejectImport=false}={}){
  const handlers={},events=[],imports=[],folders=[],selection=[];let currentFolder,activeProject,ready;
  const source=path.join(__dirname,'core.test.js');
  const clip=id=>({GetUniqueId:async()=>id,GetName:async()=>id+'.mov',GetClipProperty:async()=>source});
  const folder=(name,clips=[])=>{const children=[];return {GetName:async()=>name,GetClipList:async()=>clips,GetSubFolderList:async()=>children,children,name};};
  const a=folder('iPhone',[clip('a')]),b=folder('camera',[clip('b')]),root=folder('Master');root.children.push(a,b);currentFolder=a;selection.push(...awaitableClips(a,b));
  function awaitableClips(){return [clip('a'),clip('b')];}
  const pool={GetSelectedClips:async()=>selection,GetRootFolder:async()=>root,GetCurrentFolder:async()=>currentFolder,SetCurrentFolder:async f=>{currentFolder=f;return true;},AddSubFolder:async(parent,name)=>{const f=folder(name);parent.children.push(f);folders.push([parent.name,name]);return f;},ImportMedia:async files=>{assert.ok(files.every(p=>typeof p==='string'),'Movie import must use paths, not image-sequence dictionaries');imports.push({bin:currentFolder.name,files});if(rejectImport)throw Error('ImportMedia rejected');return failImport?[]:[{}];}};
  const project={GetUniqueId:async()=> 'project-a',GetMediaPool:async()=>pool};activeProject=project;
  let fallbacks=0;const resolve={GetProjectManager:async()=>({GetCurrentProject:async()=>activeProject}),GetMediaStorage:async()=>({AddItemListToMediaPool:async files=>{fallbacks++;assert.ok(files.every(p=>typeof p==='string'));return failImport?[]:[{}];}})};
  class Window{constructor(){this.webContents={send:(_,s)=>events.push(s),setWindowOpenHandler(){},on(){}};}setMenu(){}loadFile(){}on(){}isDestroyed(){return false;}}
  const electron={app:{whenReady:()=>({then:fn=>{ready=fn;}}),getPath:()=>__dirname,on(){},quit(){}},BrowserWindow:Window,ipcMain:{handle:(name,fn)=>{handlers[name]=fn;}},dialog:{showMessageBox:async()=>{},showOpenDialog:async()=>({canceled:true})},Notification:class {static isSupported(){return false;}}};
  let conversions=0;
  const core={checkTools:async()=>{},checkEncoder:async()=>{},findExisting:async()=>existing?source:'',probe:async()=>({}),classify:()=>({eligible:true,format:'HLG',duration:1,reason:'可转换'}),convert:async(_tools,_source,info,opts)=>{assert.equal('clip' in info,false);conversions++;opts.onProgress(100);return source;}};
  const native={InitializePromise:async()=>true,GetResolvePromise:async()=>resolve,SetAPITimeout(){},CleanUp(){}};
  const context={require:name=>name==='electron'?electron:name==='./WorkflowIntegration.node'?native:name==='./core'?core:require(name),__dirname:path.resolve(__dirname,'../ResolveHDRtoSDR'),AbortController,console};
  vm.runInNewContext(fs.readFileSync(path.join(context.__dirname,'main.js'),'utf8'),context);ready();
  return {handlers,events,imports,folders,get fallbacks(){return fallbacks;},get currentFolder(){return currentFolder;},get conversions(){return conversions;},switchProject:()=>{activeProject={GetUniqueId:async()=> 'project-b'};}};
}
test('selected clips convert into their own original bins and restore active folder',async()=>{
  const h=harness();await h.handlers.scan();await h.handlers.start(null,{mode:'hevc'});
  assert.deepEqual(h.folders,[['iPhone','转换SDR'],['camera','转换SDR']]);assert.equal(h.imports.length,2);assert.equal(h.currentFolder.name,'iPhone');assert.equal(h.events.at(-1).rows.filter(r=>r.status==='转换成功').length,2);
});
test('failed import retains output and retry does not transcode twice',async()=>{
  const h=harness({failImport:true});await h.handlers.scan();await h.handlers.start(null,{});assert.equal(h.conversions,2);assert.equal(h.events.at(-1).rows[0].status,'转换完成，导入失败');await h.handlers.start(null,{});assert.equal(h.conversions,2);assert.equal(h.currentFolder.name,'iPhone');assert.equal(h.folders.length,2);
});
test('project switching blocks conversion before writing or importing',async()=>{
  const h=harness();await h.handlers.scan();h.switchProject();await assert.rejects(h.handlers.start(null,{}),/当前项目已改变/);assert.equal(h.conversions,0);assert.equal(h.imports.length,0);
});
test('reopen recovery imports existing SDR files without conversion; storage fallback succeeds',async()=>{
  const h=harness({existing:true,rejectImport:true});await h.handlers.scan();await h.handlers.start(null,{importOnly:true});assert.equal(h.conversions,0);assert.equal(h.fallbacks,2);assert.equal(h.events.at(-1).rows.filter(r=>r.status==='转换成功').length,2);
});
test('import-only missing output never transcodes',async()=>{const h=harness();await h.handlers.scan();await h.handlers.start(null,{importOnly:true});assert.equal(h.conversions,0);assert.equal(h.imports.length,0);assert.equal(h.events.at(-1).rows[0].status,'未找到SDR副本');});
