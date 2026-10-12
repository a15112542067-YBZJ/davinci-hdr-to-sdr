'use strict';
const $=id=>document.getElementById(id);let current={busy:false,rows:[]};
function element(tag,text){const e=document.createElement(tag);e.textContent=text||'';return e;}
function render(state){current=state;$('scan').disabled=state.busy;$('start').disabled=state.busy||!state.rows.some(r=>r.eligible&&r.status!=='转换成功');$('recover').disabled=$('start').disabled;$('cancel').disabled=!state.busy;for(const id of ['mode','chooseRoot','resetRoot','save','chooseFfmpeg','chooseFfprobe'])$(id).disabled=state.busy;
  if(state.message)$('message').textContent=state.message;
  const eligible=state.rows.filter(r=>r.eligible),success=state.rows.filter(r=>r.status==='转换成功').length;
  $('counts').textContent=`${state.rows.length} 个素材 · 可转换 ${eligible.length} · 已有SDR ${state.rows.filter(r=>r.output).length} · 导入成功 ${success} · 跳过 ${state.rows.filter(r=>!r.eligible).length}`;
  $('total').value=eligible.length?eligible.reduce((a,r)=>a+(r.progress||0),0)/eligible.length:0;
  $('rows').replaceChildren();$('empty').hidden=!!state.rows.length;
  for(const r of state.rows){const tr=document.createElement('tr');const name=element('td',r.name);name.append(element('small',r.source));if(r.output)name.append(element('small','输出：'+r.output));
    const format=element('td',r.format);format.append(element('small',[r.prim,r.trc,r.matrix,r.range,r.pixFmt].filter(Boolean).join(' / ')));
    const status=element('td',r.status);status.className=r.status==='转换成功'?'success':/失败/.test(r.status)?'failure':'active';status.append(element('small',r.error||r.reason));if(r.audioNote)status.append(element('small',r.audioNote));if(r.engine)status.append(element('small',r.engine));
    const progress=element('td',Math.floor(r.progress||0)+'%');const bar=document.createElement('progress');bar.max=100;bar.value=r.progress||0;progress.append(bar);tr.append(name,format,status,progress);$('rows').append(tr);
  }
}
async function action(fn){try{const result=await fn();if(result?.rows)render(result);}catch(e){$('message').textContent=e.message;}}
window.hdr.subscribe(render);
$('scan').onclick=()=>action(()=>window.hdr.scan());$('start').onclick=()=>action(()=>window.hdr.start({mode:$('mode').value,root:$('root').value}));$('cancel').onclick=()=>action(()=>window.hdr.cancel());
$('recover').onclick=()=>action(()=>window.hdr.start({root:$('root').value,importOnly:true}));
$('chooseRoot').onclick=()=>action(async()=>{const p=await window.hdr.choose('root');if(p)$('root').value=p;});$('resetRoot').onclick=()=>{$('root').value='';};
for(const [id,kind] of [['chooseFfmpeg','ffmpeg'],['chooseFfprobe','ffprobe']])$(id).onclick=()=>action(async()=>{const p=await window.hdr.choose(kind);if(p)$(kind).value=p;});
$('save').onclick=()=>action(()=>window.hdr.save({ffmpeg:$('ffmpeg').value,ffprobe:$('ffprobe').value}));
action(async()=>{const s=await window.hdr.settings();$('ffmpeg').value=s.tools.ffmpeg;$('ffprobe').value=s.tools.ffprobe;return s;});
