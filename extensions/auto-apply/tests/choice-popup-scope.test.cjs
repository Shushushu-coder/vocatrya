const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/content.js'),'utf8');

// Minimal DOM with a tiny selector engine (tag, .class, [attr], [attr="v"], [attr*="v"], comma lists).
class El{
 constructor(tag,{cls='',attrs={},text='',hidden=false}={}){
  this.tagName=tag.toUpperCase();this.className=cls;this.attrs={...attrs};this.innerText=text;this.textContent=text;
  this.children=[];this.parentElement=null;this.hidden=hidden;
 }
 append(...kids){for(const k of kids){k.parentElement=this;this.children.push(k);}return this;}
 getAttribute(k){if(k==='class')return this.className;return k in this.attrs?this.attrs[k]:null;}
 contains(o){for(let n=o;n;n=n.parentElement){if(n===this)return true;}return false;}
 descendants(){const out=[];const walk=(n)=>{for(const c of n.children){out.push(c);walk(c);}};walk(this);return out;}
 matches(sel){
  return sel.split(',').some((part)=>{
   part=part.trim();
   const m=part.match(/^\[([\w-]+)(?:(\*?)="([^"]*)")?\]$/);
   if(m){const v=this.getAttribute(m[1]);if(v===null)return false;if(m[3]===undefined)return true;return m[2]==='*'?v.includes(m[3]):v===m[3];}
   if(part.startsWith('.'))return this.className.split(/\s+/).includes(part.slice(1));
   const t=part.match(/^(\w+)(?::not\(\[type="hidden"\]\))?$/);
   if(t){if(this.tagName!==t[1].toUpperCase())return false;return !part.includes(':not')||this.getAttribute('type')!=='hidden';}
   return false;
  });
 }
 closest(sel){for(let n=this;n;n=n.parentElement){if(n.matches(sel))return n;}return null;}
 querySelectorAll(sel){return this.descendants().filter((n)=>n.matches(sel));}
 querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
 getBoundingClientRect(){return {width:10,height:10};}
}

function harness(body){
 const window={getComputedStyle:(e)=>({display:e.hidden?'none':'block',visibility:'visible',opacity:'1'})};
 const document={
  body,documentElement:body,
  getElementById:(id)=>body.descendants().find((n)=>n.getAttribute('id')===id)||null,
  querySelectorAll:(s)=>body.querySelectorAll(s),querySelector:(s)=>body.querySelector(s),
  createElement:()=>({appendChild(){},setAttribute(){},getAttribute:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},style:{},classList:{add(){},remove(){},toggle(){}}}),
  title:'fixture'
 };
 vm.runInNewContext(source,{
  window,document,Set,Element:El,Node:{ELEMENT_NODE:1},
  HTMLInputElement:function(){},HTMLTextAreaElement:function(){},HTMLSelectElement:function(){},HTMLButtonElement:function(){},
  location:{href:'https://example.com/apply',hostname:'example.com'},
  chrome:{runtime:{onMessage:{addListener(){},removeListener(){}}}},
  CSS:{escape:(v)=>String(v)},setTimeout,clearTimeout,setInterval,clearInterval,console
 });
 return window.__OJAF_AUTOFILL_INTERNALS__;
}

const opt=(t,extra={})=>new El('li',{text:t,attrs:{role:'option'},...extra});

// Page: wide form container whose class contains "select" holding several fields; each field has a trigger
// and (portal) dropdowns live at body level, exactly like antd Select.
function buildPage(){
 const body=new El('body');
 const form=new El('form',{cls:'apply-select-form'});
 const rankInput=new El('input',{attrs:{id:'rank',role:'combobox','aria-controls':'rank_list','aria-expanded':'true'}});
 const rankHost=new El('div',{cls:'ant-select'}).append(rankInput);
 const cityInput=new El('input',{attrs:{id:'city',role:'combobox','aria-controls':'city_list'}});
 const cityHost=new El('div',{cls:'ant-select'}).append(cityInput);
 form.append(rankHost,cityHost);
 // always-visible unrelated list inside the form (e.g. static sidebar list)
 const staticList=new El('ul',{cls:'tips'}).append(opt('前10%'),opt('帮助'));
 form.append(staticList);
 const cityPopup=new El('div',{cls:'ant-select-dropdown'}).append(new El('div',{attrs:{id:'city_list',role:'listbox'}}).append(opt('北京'),opt('前5%')));
 const rankPopup=new El('div',{cls:'ant-select-dropdown'}).append(new El('div',{attrs:{id:'rank_list',role:'listbox'}}).append(opt('前30%'),opt('前50%')));
 body.append(form,cityPopup,rankPopup);
 return {body,form,rankInput,rankHost,cityInput,cityHost,cityPopup,rankPopup,staticList};
}

const labels=(list)=>Array.from(list,(o)=>o.innerText);

test('portal popup options are scoped to the field via aria-controls, not page-wide',()=>{
 const p=buildPage();
 const internals=harness(p.body);
 const roots=internals.resolveChoicePopupRoots(p.rankInput,p.rankHost,new Set());
 const options=internals.findVisibleChoiceOptions(roots);
 assert.deepEqual(labels(options),['前30%','前50%']);
});

test('getOptions on a combobox ignores options of other dropdowns',()=>{
 const p=buildPage();
 const internals=harness(p.body);
 assert.deepEqual(Array.from(internals.getOptions(p.rankInput),(o)=>o.label),['前30%','前50%']);
 assert.deepEqual(Array.from(internals.getOptions(p.cityInput),(o)=>o.label),['北京','前5%']);
});

test('form-wide select-ish ancestor is not accepted as a single-field scope',()=>{
 const p=buildPage();
 const internals=harness(p.body);
 assert.equal(internals.isSingleFieldChoiceScope(p.form,p.rankInput),false);
 assert.equal(internals.isSingleFieldChoiceScope(p.rankHost,p.rankInput),true);
 // wide ancestor must not be used as options root: the static list ("前10%") stays out
 const roots=internals.resolveChoicePopupRoots(p.rankInput,p.form,new Set());
 assert.ok(!roots.includes(p.form));
 assert.ok(!labels(internals.findVisibleChoiceOptions(roots)).includes('前10%'));
});

test('without aria links, only a unique newly opened portal popup is accepted',()=>{
 const body=new El('body');
 const trigger=new El('div',{cls:'custom-picker-trigger',attrs:{tabindex:'0'}});
 const host=new El('div',{cls:'custom-select'}).append(trigger);
 const other=new El('div',{cls:'dropdown-menu'}).append(opt('无关项'));
 body.append(host,other);
 const internals=harness(body);
 const before=new Set([other]);
 const popup=new El('div',{cls:'picker-dropdown'}).append(opt('前10%'),opt('前20%'));
 body.append(popup);
 let roots=internals.resolveChoicePopupRoots(trigger,host,before);
 assert.deepEqual(labels(internals.findVisibleChoiceOptions(roots)),['前10%','前20%']);
 // ambiguous: two unrelated new popups -> do not guess
 body.append(new El('div',{cls:'other-dropdown'}).append(opt('另一个')));
 roots=internals.resolveChoicePopupRoots(trigger,host,before);
 assert.deepEqual(labels(internals.findVisibleChoiceOptions(roots)),[]);
});

test('findVisibleChoiceOptions never falls back to document',()=>{
 const p=buildPage();
 const internals=harness(p.body);
 assert.equal(internals.findVisibleChoiceOptions([]).length,0);
 assert.equal(internals.findVisibleChoiceOptions(null).length,0);
});
