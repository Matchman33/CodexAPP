import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionHub } from "../core/sessionHub.mjs";
import { listProjectTree } from "../core/threadDisplay.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-delete-project-"));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert(path.basename(dir).startsWith("codexapp-delete-project-")); fs.rmSync(dir, { recursive: true, force: true }); });
  const projects = new Map([['p', {id:'p',name:'Project',roots:[{path:'/project'}]}], ['other',{id:'other',name:'Other',roots:[{path:'/other'}]}]]);
  const rows = new Map([
    {id:'one',projectId:'p',cwd:'/project',status:{type:'idle'}},
    {id:'archived',projectId:'p',cwd:'/project',archived:true,status:{type:'notLoaded'}},
    {id:'child',parentThreadId:'one',cwd:'/other',projectId:'other',status:{type:'idle'}},
    {id:'outside',cwd:'/other',projectId:'other',status:{type:'idle'}},
  ].map(t=>[t.id,t]));
  const calls=[], messages=[];
  const hub=new SessionHub({defaultCwd:dir},m=>messages.push(m),undefined,{dataDir:dir}); hub.control.state.codexConnected=true;
  hub.control.codex.request=async(method,p)=>{
    calls.push({method,params:p});
    if(method==='project/list')return {data:[...projects.values()],nextCursor:null};
    if(method==='thread/list'){
      const list=[...rows.values()].filter(t=>!!t.archived===!!p.archived);
      return {data:p.cursor?list.slice(1):list.slice(0,1),nextCursor:!p.cursor&&list.length>1?'next':null};
    }
    if(method==='thread/read')return {thread:rows.get(p.threadId)};
    if(method==='thread/delete'){rows.delete(p.threadId);return {};}
    if(method==='project/delete'){projects.delete(p.projectId);return {};}
    throw new Error(method);
  };
  return {hub,rows,projects,calls,messages,dir};
}
const command={type:'deleteProject',projectId:'p',confirmed:true,requestId:'delete-p'};

test('删除项目包括归档与跨目录派生会话，保留其他项目及磁盘文件',async t=>{
  const {hub,rows,projects,calls,messages,dir}=fixture(t); fs.writeFileSync(path.join(dir,'keep.txt'),'keep');
  await hub.dispatch(command,'client');
  assert.deepEqual([...rows.keys()],['outside']); assert(!projects.has('p')); assert(projects.has('other'));
  assert.equal(fs.readFileSync(path.join(dir,'keep.txt'),'utf8'),'keep');
  const deleted=calls.filter(c=>c.method==='thread/delete').map(c=>c.params.threadId); assert(deleted.indexOf('child')<deleted.indexOf('one'));
  assert(messages.some(m=>m.type==='projectDeleted'&&m.clientId==='client'&&m.threadIds.length===3));
  assert(calls.some(c=>c.method==='thread/list'&&c.params.archived===true));
});
test('未确认、运行中会话、审批和活动终端都在删除前阻止操作',async t=>{
  const {hub,rows,calls}=fixture(t);
  await assert.rejects(hub.dispatch({...command,confirmed:false},'client'),/确认/);
  rows.get('archived').status={type:'active'};
  await assert.rejects(hub.dispatch(command,'client'),/正在运行/);
  rows.get('archived').status={type:'idle'};
  hub.sessions.set('one',{state:{status:'idle'},promptQueue:{},pendingApprovals:new Map([['a',{}]])});
  await assert.rejects(hub.dispatch(command,'client'),/待审批/);
  hub.sessions.clear(); hub.terminals.list=()=>[{threadId:'one',status:'running'}];
  await assert.rejects(hub.dispatch(command,'client'),/活动终端/);
  assert(!calls.some(c=>c.method.endsWith('/delete')));
});
test('部分失败保留项目并报告实际进度，重试只删除剩余会话',async t=>{
  const f=fixture(t), request=f.hub.control.codex.request;
  f.hub.control.codex.request=(m,p)=>{if(m==='thread/delete'&&p.threadId==='one')throw new Error('fixture failure');return request(m,p);};
  await assert.rejects(f.hub.dispatch(command,'client'),/已删除 2\/3.*fixture failure/);
  assert(f.projects.has('p')); assert(!f.rows.has('child')); assert(f.rows.has('one'));
  f.hub.control.codex.request=request; await f.hub.dispatch(command,'client');
  assert(!f.projects.has('p')); assert.deepEqual([...f.rows.keys()],['outside']);
});
test('项目删除过程中阻止其他客户端发送与再次删除',async t=>{
  const f=fixture(t),request=f.hub.control.codex.request;let release;
  f.hub.control.codex.request=(m,p)=>m==='project/list'?new Promise(r=>{release=()=>r({data:[...f.projects.values()],nextCursor:null});}):request(m,p);
  const pending=f.hub.dispatch(command,'one');
  while(!release)await new Promise(r=>setImmediate(r));
  await assert.rejects(f.hub.dispatch({type:'prompt',text:'blocked',threadId:'one'},'two'),/正在删除/);
  await assert.rejects(f.hub.dispatch(command,'two'),/正在删除/);
  f.hub.control.codex.request=request;release();await pending;
});
test('项目列表以 Codex 记录为准，旧桌面分组不能让已删除项目复活',async t=>{
  const {hub,projects,dir}=fixture(t);
  fs.writeFileSync(path.join(dir,'.codex-global-state.json'),JSON.stringify({'local-projects':{legacy:{name:'Old',rootPaths:['/project']}},'project-order':['legacy']}));
  let tree=await listProjectTree(hub.control.codex,dir);assert(tree.projectDeletion);assert.equal(tree.projects[0].id,'p');
  projects.delete('p');tree=await listProjectTree(hub.control.codex,dir);assert(!tree.projects.some(p=>p.root==='/project'));
});

test('异步核对状态前暂停等待队列，核对失败不删除任何记录',async t=>{
  const {hub,calls}=fixture(t);let paused=false;
  hub.sessions.set('one',{state:{status:'idle'},pendingApprovals:new Map(),promptQueue:{pause(){paused=true;}}});
  const request=hub.control.codex.request;
  hub.control.codex.request=(method,params)=>{
    if(method==='thread/read'){assert(paused);throw new Error('fixture unreadable');}
    return request(method,params);
  };
  await assert.rejects(hub.dispatch(command,'client'),/已删除 0\/3.*fixture unreadable/);
  assert(!calls.some(c=>c.method.endsWith('/delete')));
});
