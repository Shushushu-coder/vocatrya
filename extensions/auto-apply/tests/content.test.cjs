const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/content.js'),'utf8');

class FakeElement{
 constructor(tag='div',text=''){
  this.tagName=tag.toUpperCase();this.nodeName=this.tagName;
  this.children=[];this.parentElement=null;this.className='';
  this.attrs={};this.innerText=text;this.textContent=text;this.isControl=false;
 }
 getAttribute(k){return this.attrs[k]??null;}
 setAttribute(k,v){this.attrs[k]=String(v);}
 closest(){return null;}
 matches(){return false;}
 contains(){return false;}
 querySelector(){return null;}
 querySelectorAll(){
  const out=[];const walk=(n)=>{for(const c of n.children){if(c.isControl)out.push(c);walk(c);}};
  walk(this);return out;
 }
 cloneNode(){
  const copy=(src,dst)=>{
   for(const ch of src.children){
    const cc=new FakeElement(ch.tagName,ch.innerText);
    cc.className=ch.className;cc.isControl=ch.isControl;cc.attrs={...ch.attrs};
    dst.append(cc);copy(ch,cc);
   }
  };
  const c=new FakeElement(this.tagName,this.innerText);c.className=this.className;copy(this,c);return c;
 }
 append(child){child.parentElement=this;this.children.push(child);return child;}
 remove(){const i=this.parentElement?.children.indexOf(this)??-1;if(i>=0)this.parentElement.children.splice(i,1);}
 getBoundingClientRect(){return {width:10,height:10};}
}

const control=(tag='input',text='')=>{const e=new FakeElement(tag,text);e.isControl=true;return e;};

function harness(overrides={}){
 const window=overrides.window||{};
 const element=()=>({appendChild(){},setAttribute(){},getAttribute:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},style:{},classList:{add(){},remove(){},toggle(){}},hidden:true});
 const document=overrides.document||{
  getElementById:()=>null,
  querySelector:()=>null,
  querySelectorAll:()=>[],
  createElement:element,
  documentElement:{appendChild(){}},
  title:'fixture'
 };
 const context={
  window,
  document,
  location:{href:'https://example.com/apply',hostname:'example.com'},
  chrome:{runtime:{onMessage:{addListener(){},removeListener(){}}}},
  CSS:{escape:(v)=>String(v)},
  Node:{ELEMENT_NODE:1},
  Element:FakeElement,
  HTMLInputElement:function(){},
  HTMLTextAreaElement:function(){},
  HTMLSelectElement:function(){},
  HTMLButtonElement:function(){},
  setTimeout,clearTimeout,setInterval,clearInterval,console
 };
 vm.runInNewContext(source,context);
 return window.__OJAF_AUTOFILL_INTERNALS__;
}

const field=(over={})=>({
 fieldId:'',type:'text',tagName:'input',label:'',placeholder:'',name:'',id:'',
 required:false,disabled:false,readOnly:false,hasCurrentValue:false,currentValue:'',
 canFill:true,section:'',nearbyText:'',groupText:'',repeatGroupId:'',
 options:[],cssPath:'',siteAdapterId:'',siteAdapterName:'',...over
});

const repeatSection=(title,items)=>({title,kind:'repeat',items:items.map((values,index)=>({title:`${title} ${index+1}`,values,custom:[]}))});

const entriesOf=(internals,profileV2)=>internals.buildProfileEntries(internals.profileV2ToProfileSections(profileV2));

const educationProfile=(items)=>({sections:{education:repeatSection('教育经历',items)}});

function fieldsFromGroups(groups){
 const fields=[];
 for(const [groupId,labels,section] of groups){
  for(const label of labels){
   fields.push(field({fieldId:`f_${groupId}_${label}`,label,section,repeatGroupId:groupId}));
  }
 }
 return fields;
}

const candidateFor=(plan,fieldId)=>plan.candidates.find((candidate)=>candidate.fieldId===fieldId);

test('profile repeat items carry per-category itemOccurrenceIndex',()=>{
 const internals=harness();
 const entries=entriesOf(internals,{sections:{
  education:repeatSection('教育经历',[{'学校':'大学A'},{'学校':'大学B'}]),
  internship:repeatSection('实习经历',[{'公司':'公司甲'}]),
  basics:{title:'基本信息',kind:'simple',values:{'姓名':'张三'},custom:[]}
 }});
 const edu=entries.filter((entry)=>entry.category==='教育经历');
 assert.equal(edu.find((entry)=>entry.value==='大学A').itemOccurrenceIndex,1);
 assert.equal(edu.find((entry)=>entry.value==='大学B').itemOccurrenceIndex,2);
 assert.equal(entries.find((entry)=>entry.value==='公司甲').itemOccurrenceIndex,1);
 assert.equal(entries.find((entry)=>entry.label==='姓名').itemOccurrenceIndex,0);
});

test('nth repeat block binds nth profile item of its category',()=>{
 const internals=harness();
 const profile=educationProfile([{'学校':'大学A','专业':'专业A'},{'学校':'大学B','专业':'专业B'}]);
 const scan={fields:fieldsFromGroups([['g1',['学校','专业'],'教育经历'],['g2',['学校','专业'],'教育经历']])};
 const plan=internals.buildAutofillPlan(scan,entriesOf(internals,profile));
 assert.equal(candidateFor(plan,'f_g1_学校').value,'大学A');
 assert.equal(candidateFor(plan,'f_g2_学校').value,'大学B');
 assert.equal(candidateFor(plan,'f_g1_专业').value,'专业A');
 assert.equal(candidateFor(plan,'f_g2_专业').value,'专业B');
});

test('repeat binding works when profile item titles have no digits',()=>{
 const internals=harness();
 const profile={sections:{education:{title:'教育经历',kind:'repeat',items:[
  {title:'本科',values:{'学校':'大学A'}},
  {title:'硕士',values:{'学校':'大学B'}}
 ]}}};
 const scan={fields:fieldsFromGroups([['g1',['学校'],'教育经历'],['g2',['学校'],'教育经历']])};
 const plan=internals.buildAutofillPlan(scan,entriesOf(internals,profile));
 assert.equal(candidateFor(plan,'f_g1_学校').value,'大学A');
 assert.equal(candidateFor(plan,'f_g2_学校').value,'大学B');
});

test('occurrence mismatch is rejected for local and AI candidates',()=>{
 const internals=harness();
 assert.equal(internals.isRepeatGroupOccurrenceMismatch({repeatGroupIndex:2},{itemOccurrenceIndex:1}),true);
 assert.equal(internals.isRepeatGroupOccurrenceMismatch({repeatGroupIndex:2},{itemOccurrenceIndex:2}),false);
 assert.equal(internals.isRepeatGroupOccurrenceMismatch({repeatGroupIndex:0},{itemOccurrenceIndex:1}),false);
 assert.equal(internals.isRepeatGroupOccurrenceMismatch({repeatGroupIndex:1},{itemOccurrenceIndex:0}),false);

 const profile=educationProfile([{'学校':'大学A'},{'学校':'大学B'}]);
 const entries=entriesOf(internals,profile);
 const scan={fields:fieldsFromGroups([['g1',['学校'],'教育经历'],['g2',['学校'],'教育经历']])};
 internals.buildAutofillPlan(scan,entries);
 const wrong=internals.createAiAutofillCandidate({fieldId:'f_g2_学校',sourcePath:'profileV2.sections.education.items[0].values[0]',confidence:0.9},scan,entries);
 const right=internals.createAiAutofillCandidate({fieldId:'f_g2_学校',sourcePath:'profileV2.sections.education.items[1].values[0]',confidence:0.9},scan,entries);
 assert.equal(wrong,null);
 assert.equal(right.value,'大学B');
});

test('block without matching profile item is reported, not silently skipped',()=>{
 const internals=harness();
 const profile=educationProfile([{'学校':'大学A'}]);
 const scan={fields:fieldsFromGroups([['g1',['学校'],'教育经历'],['g2',['学校'],'教育经历']])};
 const plan=internals.buildAutofillPlan(scan,entriesOf(internals,profile));
 assert.equal(candidateFor(plan,'f_g1_学校').value,'大学A');
 assert.equal(candidateFor(plan,'f_g2_学校'),undefined);
 assert.equal(plan.unmatchedBlocks.length,1);
 assert.equal(plan.unmatchedBlocks[0].category,'教育经历');
 assert.equal(plan.unmatchedBlocks[0].groupIndex,2);
 assert.equal(plan.unmatchedBlocks[0].fieldIds.join(','),'f_g2_学校');
 const note=internals.formatUnmatchedBlocksNote(plan.unmatchedBlocks);
 assert.match(note,/1 个重复块无匹配资料条目/);
 assert.match(note,/教育经历第 2 块/);
});

test('block with compatible item but no matched fields is not flagged',()=>{
 const internals=harness();
 const profile=educationProfile([{'学校':'大学A'},{'学校':'大学B'}]);
 const scan={fields:fieldsFromGroups([['g1',['完全未知字段'],'教育经历'],['g2',['另一个未知字段'],'教育经历']])};
 const plan=internals.buildAutofillPlan(scan,entriesOf(internals,profile));
 assert.equal(plan.unmatchedBlocks.length,0);
});

test('english education labels resolve to chinese profile entries',()=>{
 const internals=harness();
 const profile=educationProfile([{'学校':'大学A','专业':'专业A','开始时间':'2018-09','结束时间':'2022-06'},{'学校':'大学B','专业':'专业B','开始时间':'2022-09','结束时间':'2024-06'}]);
 const scan={fields:fieldsFromGroups([
  ['g1',['School','Major','Start Date','End Date'],'Education'],
  ['g2',['School','Major','Start Date','End Date'],'Education']
 ])};
 const plan=internals.buildAutofillPlan(scan,entriesOf(internals,profile));
 assert.equal(scan.fields.find((item)=>item.fieldId==='f_g1_School').inferredCategory,'教育经历');
 assert.equal(candidateFor(plan,'f_g1_School').value,'大学A');
 assert.equal(candidateFor(plan,'f_g2_School').value,'大学B');
 assert.equal(candidateFor(plan,'f_g2_Major').value,'专业B');
 assert.equal(candidateFor(plan,'f_g2_Start Date').value,'2022-09');
 assert.equal(candidateFor(plan,'f_g2_Start Date').writeMode,'date');
 assert.equal(candidateFor(plan,'f_g1_End Date').value,'2022-06');
});

test('english work/internship labels match and section inference covers english',()=>{
 const internals=harness();
 assert.equal(internals.inferMatchSection(field({section:'Internship Experience'})),'实习经历');
 assert.equal(internals.inferMatchSection(field({section:'Work History'})),'工作经历');
 assert.equal(internals.inferMatchSection(field({section:'Employment'})),'工作经历');
 assert.equal(internals.inferMatchSection(field({section:'Projects'})),'项目经历');
 assert.equal(internals.inferMatchSection(field({section:'Family Members'})),'家庭信息');

 const profile={sections:{internship:repeatSection('实习经历',[{'公司':'公司甲','职位':'实习生'},{'公司':'公司乙','职位':'工程师'}])}};
 const scan={fields:fieldsFromGroups([
  ['g1',['Company','Position'],'Internship'],
  ['g2',['Company','Position'],'Internship']
 ])};
 const plan=internals.buildAutofillPlan(scan,entriesOf(internals,profile));
 assert.equal(candidateFor(plan,'f_g1_Company').value,'公司甲');
 assert.equal(candidateFor(plan,'f_g2_Company').value,'公司乙');
 assert.equal(candidateFor(plan,'f_g2_Position').value,'工程师');
});

test('family blocks bind by relation, not by position index',()=>{
 const internals=harness();
 const profile={sections:{family:{title:'家庭信息',kind:'repeat',items:[
  {title:'父亲',values:{'工作单位':'单位父'}},
  {title:'母亲',values:{'工作单位':'单位母'}}
 ]}}};
 const scan={fields:[
  field({fieldId:'f_mother',label:'工作单位',section:'家庭信息',nearbyText:'母亲',repeatGroupId:'fam1'}),
  field({fieldId:'f_father',label:'工作单位',section:'家庭信息',nearbyText:'父亲',repeatGroupId:'fam2'})
 ]};
 const plan=internals.buildAutofillPlan(scan,entriesOf(internals,profile));
 assert.equal(candidateFor(plan,'f_mother').value,'单位母');
 assert.equal(candidateFor(plan,'f_father').value,'单位父');
});

test('english label map translates common labels',()=>{
 const internals=harness();
 for(const [english,chinese] of [['School','学校'],['Major','专业名称'],['Degree','学位'],['Company','公司'],['Position','职位'],['Start Date','开始时间'],['End Date','结束时间'],['Email','邮箱'],['Phone','手机号码'],['Award','奖惩名称'],['Certificate','证书名称']]){
  assert.equal(internals.getFieldMatchLabel(null,english),chinese,english);
 }
 assert.equal(internals.getFieldMatchLabel(null,'学校'),'学校');
});

test('repeat group ids distinguish sibling item blocks in nested list',()=>{
 const body=new FakeElement('body');
 const document={
  getElementById:()=>null,
  querySelector:()=>null,
  querySelectorAll:(sel)=>{
   const match=String(sel).match(/data-ojaf-repeat-id="([^"]+)"/);
   const out=[];const walk=(n)=>{if(match&&n.attrs?.['data-ojaf-repeat-id']===match[1])out.push(n);for(const c of n.children||[])walk(c);};
   walk(body);return out;
  },
  createElement:()=>new FakeElement(),
  documentElement:{appendChild(){}}
 };
 const internals=harness({document,window:{getComputedStyle:()=>({display:'',visibility:'',opacity:'1'})}});
 const itemA=new FakeElement('div','学校：大学A 专业：专业A');itemA.className='form-item';
 const a1=control('input'),a2=control('input');itemA.append(a1);itemA.append(a2);
 const itemB=new FakeElement('div','学校：大学B 专业：专业B');itemB.className='form-item';
 const b1=control('input'),b2=control('input');itemB.append(b1);itemB.append(b2);
 const list=new FakeElement('div');list.append(itemA);list.append(itemB);body.append(list);
 const solo=new FakeElement('div','姓名：张三');solo.className='form-item';
 const s1=control('input'),s2=control('input');solo.append(s1);solo.append(s2);body.append(solo);
 const idA=internals.getFieldRepeatGroupId(a1);
 const idB=internals.getFieldRepeatGroupId(b1);
 assert.ok(idA);
 assert.ok(idB);
 assert.notEqual(idA,idB);
 assert.equal(internals.getFieldRepeatGroupId(b2),idB);
 assert.equal(internals.getFieldRepeatGroupId(a2),idA);
 assert.equal(internals.getFieldRepeatGroupId(s1),'');
});

test('getOrCreateRepeatGroupId re-assigns ids carried by clones',()=>{
 const holders=[];
 const internals=harness({document:{
  getElementById:()=>null,
  querySelector:()=>null,
  querySelectorAll:(selector)=>{
   const match=String(selector).match(/data-ojaf-repeat-id="([^"]+)"/);
   return match?holders.filter((root)=>root.attrs['data-ojaf-repeat-id']===match[1]):[];
  },
  createElement:()=>({}),
  documentElement:{appendChild(){}}
 }});
 const root=(id)=>{const r={attrs:{'data-ojaf-repeat-id':id},getAttribute:(k)=>r.attrs[k]??null,setAttribute:(k,v)=>{r.attrs[k]=v;}};return r;};
 const a=root(null);holders.push(a);
 const idA=internals.getOrCreateRepeatGroupId(a);
 assert.ok(idA);
 assert.equal(internals.getOrCreateRepeatGroupId(a),idA);
 const b=root(idA);holders.push(b);
 const idB=internals.getOrCreateRepeatGroupId(b);
 assert.notEqual(idB,idA);
 assert.equal(b.attrs['data-ojaf-repeat-id'],idB);
 assert.equal(internals.getOrCreateRepeatGroupId(b),idB);
});
