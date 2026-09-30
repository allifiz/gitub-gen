import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/background.ts', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('async function scrapeProjectViewInBrowser('), source.indexOf('async function scrapeProjectRecap('));
const code = ts.transpile(fn, { target: ts.ScriptTarget.ES2022 });
function fixture({ total=50, lazy=true, stalled=false, height=200 }={}) {
 let clock=0, available=lazy?30:total, bottomAt=null, top=0, visibleTop=0, pending=null;
 const scroller={clientHeight:height, parentElement:null,
  get scrollHeight(){ return available*20; },
  get scrollTop(){return top;}, set scrollTop(v){
   const next=Math.max(0,Math.min(v,this.scrollHeight-height));
   if(next!==top){top=next;pending={at:clock+1400,top};}
  }, dispatchEvent(){} };
 const links=()=>Array.from({length:Math.min(Math.ceil(height/20),available-Math.floor(visibleTop/20))},(_,i)=>{
  const n=Math.floor(visibleTop/20)+i+1;
  return {href:`https://github.com/example/repo/issues/${n}`,innerText:`[TEST] Ticket ${n}`,getAttribute(){return null;},closest(){return {parentElement:scroller,querySelectorAll(){return [];}};}};
 });
 const document={body:{innerText:'Project'},scrollingElement:scroller,querySelector(){return null;},
 querySelectorAll(selector){return selector.includes('a[href')?links():[];}};
 const context=vm.createContext({document,window:{location:{pathname:'/orgs/example/projects/1'}},URL,Event,
  getComputedStyle:()=>({overflowY:'auto'}),Date:class extends Date {static now(){return clock;}},
  setTimeout(resolve,ms){clock+=ms;
   if(pending&&clock>=pending.at){visibleTop=pending.top;pending=null;}
   if(top>=scroller.scrollHeight-height&&bottomAt===null)bottomAt=clock;
   if(lazy&&!stalled&&bottomAt!==null&&clock-bottomAt>=3500)available=total;
   resolve();
  }});
 vm.runInContext(code,context);
 return {run:(expected)=>context.scrapeProjectViewInBrowser('Allief',expected)};
}
test('collects all 50 when last 20 arrive late after an apparent bottom', async()=>{
 const result=await fixture().run(50);
 assert.equal(result.rows.length,50);
 assert.equal(new Set(result.rows.map(r=>r.ticketUrl)).size,50);
});
test('blocks partial 30/50 instead of exporting success',async()=>{
 assert.match((await fixture({stalled:true}).run(50)).error, /30\/50/);
});
test('overlapping scroll retains all rows in a small viewport with delayed rendering',async()=>{
 assert.equal((await fixture({lazy:false,height:100}).run(50)).rows.length,50);
});
test('incorrect expected total is rejected',async()=>{
 assert.match((await fixture({lazy:false}).run(20)).error, /melebihi target/);
});
