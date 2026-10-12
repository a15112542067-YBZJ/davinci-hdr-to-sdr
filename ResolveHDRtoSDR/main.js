'use strict';
const {app,BrowserWindow,ipcMain,dialog,Notification}=require('electron');
const fs=require('fs'),path=require('path'),core=require('./core');
const native=require('./WorkflowIntegration.node');
const ID='com.local.resolve.hdrtosdr';
let win,resolve,project,pool,rows=[],busy=false,controller,configFile;
let tools={ffmpeg:'',ffprobe:''};
const list=x=>Array.isArray(x)?x:Object.values(x||{});
function snapshot(message=''){return {busy,message,rows:rows.map(({clip,folder,...r})=>r),tools};}
function send(message=''){if(win&&!win.isDestroyed())win.webContents.send('state',snapshot(message));}
async function connect(){if(!resolve){if(!await native.InitializePromise(ID))throw Error('无法连接达芬奇工作流接口');native.SetAPITimeout(30);resolve=await native.GetResolvePromise();}return resolve;}
async function current(){return await (await (await connect()).GetProjectManager()).GetCurrentProject();}
async function assertProject(){const p=await current();if(!p||await p.GetUniqueId()!==await project.GetUniqueId())throw Error('当前项目已改变，请切回识别素材时的项目');}
async function folderMap(root,map=new Map()){
  for(const clip of list(await root.GetClipList()))map.set(await clip.GetUniqueId(),root);
  for(const folder of list(await root.GetSubFolderList()))await folderMap(folder,map);
  return map;
}
async function scan(){
  if(busy)throw Error('任务正在运行');busy=true;controller=new AbortController();rows=[];send('正在读取媒体池选中素材…');
  try{
    await core.checkTools(tools,controller.signal);
    project=await current();if(!project)throw Error('请先打开一个项目');pool=await project.GetMediaPool();
    const selected=list(await pool.GetSelectedClips());if(!selected.length)throw Error('请在媒体池选中素材，再点击识别素材格式');
    const folders=await folderMap(await pool.GetRootFolder());
    for(const clip of selected){
      if(controller.signal.aborted)break;
      const file=await clip.GetClipProperty('File Path');
      const row={id:await clip.GetUniqueId(),name:await clip.GetName(),source:file||'',clip,folder:folders.get(await clip.GetUniqueId()),status:'识别中',progress:0,eligible:false,format:'待识别',reason:'',output:''};rows.push(row);send();
      try{if(!file||!fs.existsSync(file))throw Error('无有效原始文件路径（离线、复合片段或时间线）');if(!row.folder)throw Error('找不到原素材所在媒体池文件夹');Object.assign(row,core.classify(await core.probe(tools.ffprobe,file,controller.signal),tools.audioDecoders));row.status=row.eligible?'可转换':'跳过';}
      catch(e){row.status=e.name==='Cancelled'?'已取消':'识别失败';row.reason=e.message;}
      send();
    }
  }finally{busy=false;send(`识别完成：${rows.filter(r=>r.eligible).length} 个可转换 / ${rows.length} 个素材`);}
  return snapshot();
}
async function importOutput(row){
  await assertProject();
  const original=await pool.GetCurrentFolder();
  try{
    let target=list(await row.folder.GetSubFolderList());
    let bin=null;for(const folder of target)if(await folder.GetName()==='转换SDR'){bin=folder;break;}
    if(!bin)bin=await pool.AddSubFolder(row.folder,'转换SDR');
    if(!bin||!await pool.SetCurrentFolder(bin))throw Error('无法创建或进入转换SDR媒体池文件夹');
    const existing=list(await bin.GetClipList());
    for(const item of existing){const file=await item.GetClipProperty('File Path');if(file&&path.resolve(file).toLowerCase()===path.resolve(row.output).toLowerCase())return;}
    let imported;
    try{imported=list(await pool.ImportMedia([row.output]));}
    catch(e){const storage=await (await connect()).GetMediaStorage();imported=list(await storage.AddItemListToMediaPool([row.output]));}
    if(!imported.length){const storage=await (await connect()).GetMediaStorage();imported=list(await storage.AddItemListToMediaPool([row.output]));}
    if(!imported.length)throw Error('SDR 文件已生成，但导入媒体池失败');
  }finally{if(original)await pool.SetCurrentFolder(original);}
}
async function start(options){
  if(busy)throw Error('任务正在运行');if(!project)throw Error('请先识别素材');
  const mode=['dnxhr','hevc','hevc_gpu'].includes(options?.mode)?options.mode:'hevc_gpu';const root=typeof options?.root==='string'?options.root:'';const importOnly=options?.importOnly===true;
  const pending=rows.filter(r=>r.eligible&&r.status!=='转换成功');if(!pending.length)throw Error('没有待转换的 HDR 素材');
  busy=true;controller=new AbortController();send('正在准备批量转换…');let started=false;
  try{
    await assertProject();
    await core.checkTools(tools,controller.signal);
    if(!importOnly)await core.checkEncoder(tools,mode,controller.signal);
    started=true;send('正在批量转换…');
    for(const row of pending){
      if(controller.signal.aborted)break;
      try{
        await assertProject();
        row.error='';
        if(!row.output||!fs.existsSync(row.output))row.output=await core.findExisting(tools,row.source,row,{root,signal:controller.signal});
        if(!row.output||!fs.existsSync(row.output)){
          if(importOnly){row.status='未找到SDR副本';row.error='当前输出目录内没有通过验证的对应 SDR 文件';send();continue;}
          row.status='转换中';row.progress=0;send();
          row.engine=mode==='hevc_gpu'?'NVIDIA NVDEC 解码 / GPU 色调映射 / NVENC 编码':mode==='dnxhr'?'GPU 色调映射 / CPU DNxHR 编码':'GPU 色调映射 / CPU HEVC 编码';
          const {clip,folder,...info}=row;
          row.output=await core.convert(tools,row.source,info,{mode,root,signal:controller.signal,onProgress:p=>{row.progress=p;send();}});
        }
        row.status='导入中';row.progress=100;send();await importOutput(row);row.status='转换成功';
      }catch(e){row.status=e.name==='Cancelled'?'已取消':row.output?'转换完成，导入失败':'转换失败';row.error=e.message;}
      send();
    }
    if(controller.signal.aborted)for(const row of pending)if(row.status==='可转换')row.status='已取消';
  }finally{
    busy=false;
    const ok=rows.filter(r=>r.status==='转换成功').length;
    const failed=rows.filter(r=>/失败/.test(r.status)).length;
    const converted=rows.filter(r=>r.output).length;
    const message=started?`${controller.signal.aborted?'批量任务已取消':'批量任务完成'}：已有SDR ${converted}，导入成功 ${ok}，失败 ${failed}，未找到 ${rows.filter(r=>r.status==='未找到SDR副本').length}`:'任务未启动，请检查项目和转换工具';
    send(message);if(started){if(Notification.isSupported())new Notification({title:'HDR 转 SDR',body:message}).show();
    await dialog.showMessageBox(win,{type:failed?'warning':'info',title:'HDR 转 SDR',message,detail:'成功文件已导入各原素材所在媒体池文件夹的“转换SDR”子文件夹。失败详情可在列表中查看。'});}
  }
}
app.whenReady().then(()=>{
  configFile=path.join(app.getPath('userData'),'hdr-to-sdr-tools.json');
  try{tools={...tools,...JSON.parse(fs.readFileSync(configFile,'utf8'))};}catch(_){}
  win=new BrowserWindow({width:1160,height:790,minWidth:900,minHeight:620,backgroundColor:'#11151b',webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.setMenu(null);win.loadFile(path.join(__dirname,'index.html'));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
  win.on('close',e=>{if(busy){e.preventDefault();send('任务运行中，请先取消，等待进程停止后再关闭');}});
});
ipcMain.handle('settings',()=>snapshot());
ipcMain.handle('scan',()=>scan());
ipcMain.handle('start',async(_,options)=>{await start(options);return snapshot();});
ipcMain.handle('cancel',()=>{controller?.abort();send('正在停止当前任务…');});
ipcMain.handle('save',(_,values)=>{if(busy)throw Error('任务正在运行');for(const key of ['ffmpeg','ffprobe'])if(typeof values[key]==='string')tools[key]=values[key];fs.writeFileSync(configFile,JSON.stringify(tools,null,2));return snapshot();});
ipcMain.handle('choose',async(_,kind)=>{const result=await dialog.showOpenDialog(win,{properties:kind==='root'?['openDirectory','createDirectory']:['openFile'],filters:kind==='root'?[]:[{name:'工具程序',extensions:['exe']}]});return result.canceled?'':result.filePaths[0];});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{controller?.abort();try{native.CleanUp();}catch(_){}});
