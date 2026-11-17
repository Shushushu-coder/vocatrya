// Controlled DOM fixtures exercise refusal and delayed closing in a real Chromium.
// These are deliberately synthetic controls, separate from the actual antd happy path.
export async function runNegativeScenarios(newFixturePage, record) {
  const page = await newFixturePage('negative.html');
  try {
    const safety = await page.evaluate(async () => {
      const api = window.__OJAF_AUTOFILL_INTERNALS__;
      const selected = api.findAddBlockButton('教育经历');
      selected?.click();
      document.querySelector('#safe').remove();
      const unsafeOnly = api.findAddBlockButton('教育经历');
      // Confirm the native submit counter is live, then reset it for the extension run.
      document.querySelector('button[type="submit"]').click();
      const counterWorks = window.__SUBMIT_COUNT__ === 1;
      window.__SUBMIT_COUNT__ = 0; window.__TRAP_CLICKS__ = 0;
      const seed = document.createElement('input'); seed.id = 'seed'; document.body.append(seed);
      const candidate = {id:'seed',fieldId:'seed',fieldLabel:'姓名',value:'张三',
        field:{id:'seed',cssPath:'#seed',label:'姓名'},shouldAutoFill:true};
      const plan = {candidates:[candidate],scan:{fields:[]},entries:[
        {category:'教育经历',itemOccurrenceIndex:2,hasValue:true}
      ]};
      const result = await api.applyAutofillPlan(plan,['seed']);
      return { selectedId:selected?.id, unsafeFound:Boolean(unsafeOnly), counterWorks,
        safeClicks:window.__SAFE_CLICKS__,trapClicks:window.__TRAP_CLICKS__,submits:window.__SUBMIT_COUNT__,result };
    });
    record('N1 提交/默认提交/危险祖先/导航均排除，安全新增仍可用',
      safety.selectedId === 'safe' && !safety.unsafeFound && safety.safeClicks === 1, JSON.stringify(safety));
    record('N2 原生 submit 计数有效，完整填写与扩块路径未提交',
      safety.counterWorks && safety.submits === 0 && safety.trapClicks === 0 && safety.result.expandedBlocks === 0,
      JSON.stringify(safety));

    const dates = await page.evaluate(async () => {
      const api = window.__OJAF_AUTOFILL_INTERNALS__;
      const invalid = document.querySelector('#invalid');
      const changed = document.querySelector('#changed');
      const refused = await api.fillFrameworkDateField(invalid,invalid.parentElement,'2024-09',{},{});
      const reset = await api.fillFrameworkDateField(changed,changed.parentElement,'2024-09',{},{});
      return {refused,reset,invalidValue:invalid.value,changedValue:changed.value};
    });
    record('N3 aria-invalid 拒绝，即使文本与目标相同', dates.refused.ok === false && dates.refused.reason === '日期被控件标记无效' && dates.invalidValue === '2024-09', JSON.stringify(dates));
    record('N4 blur 改为其他非空日期也不得成功', dates.reset.ok === false && dates.changedValue === '2001-02', JSON.stringify(dates));

    const range = await page.evaluate(async () => {
      const api = window.__OJAF_AUTOFILL_INTERNALS__;
      const candidates = ['start','end'].map((id,index)=>({
        id,fieldId:id,fieldLabel:index?'结束时间':'开始时间',value:index?'2027-06':'2024-09',writeMode:'date',
        field:{id,cssPath:'#'+id,label:index?'结束时间':'开始时间',dateRangeKey:'range'},shouldAutoFill:true
      }));
      const result = await api.applyAutofillPlan({candidates,entries:[],scan:{fields:[]}},['start','end']);
      const snapshot = () => ({values:['start','end'].map(id=>document.getElementById(id).value),
        marks:['start','end'].map(id=>document.getElementById(id).getAttribute('data-ojaf-mark'))});
      const immediate = snapshot();
      const debugResponse = await window.__ojafSend({type:'OJAF_GET_DEBUG_SNAPSHOT'});
      const summary = (debugResponse.data || debugResponse).summary;
      await new Promise(resolve=>setTimeout(resolve,200));
      return {result,summary,immediate,later:snapshot(),closes:window.__CLOSE_COUNT__};
    });
    record('N5 关闭延迟清空区间后才返回，双端标为待处理', range.closes > 0 &&
      range.immediate.values.every(v=>v==='') && range.immediate.marks.every(v=>v==='uncertain') &&
      JSON.stringify(range.immediate) === JSON.stringify(range.later), JSON.stringify(range));
    record('N6 区间拒绝同步 filled/failed/pending 和逐项结果', range.result.filled === 0 &&
      range.result.failed === 2 && range.summary.pending === 2 && range.summary.filled === 0 && range.result.results.length === 2 && range.result.results.every(r=>!r.ok), JSON.stringify(range));
  } finally { await page.close(); }
}
