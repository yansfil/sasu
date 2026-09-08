import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { prepareSource, prepareVisual } from './frozen-fixtures.mjs';

const root = import.meta.dirname;
const arms = {unified:'/Users/hoyeonlee/projects/sasu',split:'/Users/hoyeonlee/projects/sasu.worktrees/parallel-review-comparison'};
const expected = {'complete':[], 'middle-omission':['B17'], 'final-omission':['B30'], 'unwired':['B28'], 'storage-failure':['B31'], 'authorized-assumptions':[], 'visual':[]};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file,value) => fs.writeFileSync(path.join(root,file),JSON.stringify(value,null,2)+'\n');
const event = value => { const item={at:new Date().toISOString(),...value}; fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify(item)+'\n'); console.log(JSON.stringify(item)); };
const modules = {};
for (const [arm,harness] of Object.entries(arms)) {
  modules[arm] = {
    ...await import(`${harness}/cli/dist/implement/prompts.js`),
    ...await import(`${harness}/cli/dist/judge/runner.js`),
    ...await import(`${harness}/cli/dist/judge/types.js`),
    ...await import(`${harness}/cli/dist/config.js`),
    ...await import(`${harness}/cli/test/helpers/implement-live-review.mjs`),
  };
}
for (const key of Object.keys(process.env)) if (key.startsWith('SASU_JUDGE_STUB') || key === 'SASU_JUDGE_BACKEND') throw new Error(`unexpected judge override: ${key}`);
const fixtures = {};
for (const variant of Object.keys(expected)) {
  const dir = path.join(root,'fixtures',variant); fs.mkdirSync(dir,{recursive:true});
  const saved = path.join(dir,'material.json');
  const material = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved,'utf8')) : null;
  const fixture = material ? {root:dir,material,options:{agentic:true,cwd:dir,evidencePaths:material.readablePaths,...(variant==='visual'?{images:[path.join(dir,'visual.png')]}:{})}} : variant === 'visual' ? await prepareVisual(dir) : await prepareSource(variant,dir);
  fixtures[variant] = fixture;
  write(`fixtures/${variant}/material.json`,fixture.material);
}
const roster = {schema:'parallel-review.quality-roster.v1',frozenAt:new Date().toISOString(),arms:Object.fromEntries(Object.entries(arms).map(([arm,harness])=>[arm,{harness,commit:spawnSync('git',['-C',harness,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim()}])),armOrder:['unified','split'],cases:Object.entries(fixtures).map(([variant,f])=>({variant,expectedBlockingRefs:expected[variant],materialSha256:hash(JSON.stringify(f.material)),files:f.options.evidencePaths.map(p=>({path:p,sha256:hash(fs.readFileSync(path.join(f.root,p)))}))})),profile:{primary:{backend:'codex',model:'gpt-5.6-luna',effort:'xhigh'},fallback:null}};
assert.equal(roster.arms.unified.commit,'3f549dcfff71fe1f7fa974a383f6e8a055ce8463');
assert.equal(roster.arms.split.commit,'6b88d83ce325a2a871af69d4e32cdf737c6dc229');
write('roster.json',roster);
if (process.argv.includes('--freeze-only')) process.exit(0);
// Exclusive creation refuses a second experiment replay over the same records.
fs.writeFileSync(path.join(root,'execution-started.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid})+'\n',{flag:'wx'});
const results=[];
for (const [variant,fixture] of Object.entries(fixtures)) for (const [arm,harness] of Object.entries(arms)) {
  const mod=modules[arm], roles=arm==='unified'?['unified']:['fidelity','code'];
  const config=mod.loadConfig(fixture.root); config.judge.profiles.routine=structuredClone(roster.profile);
  const startedAt=new Date().toISOString(), start=Date.now();
  event({type:'case-start',variant,arm});
  const reviews=Object.fromEntries(await Promise.all(roles.map(async role=>{
    const laneStart=new Date().toISOString(); let validationAttempt=0;
    const prompt=arm==='unified'?mod.reviewPrompt(fixture.material):mod.reviewPrompt(fixture.material,role);
    fs.mkdirSync(path.join(root,'prompts'),{recursive:true}); fs.writeFileSync(path.join(root,'prompts',`${variant}-${arm}-${role}.txt`),prompt);
    try {
      const outcome=await mod.runJudge(config,`smoke:implement:review:${role}:${variant}`,'routine',prompt,value=>{
        const parsed=mod.validateReviewResult(value,fixture.material.referenceContext);
        event({type:'validation',variant,arm,role,attempt:++validationAttempt,error:typeof parsed==='string'?parsed:null,references:Array.isArray(value?.findings)?value.findings.map(f=>({kind:f.kind,requirementRefs:f.requirementRefs,evidenceRefs:f.evidenceRefs})):null});
        return parsed;
      },fixture.options);
      const record={status:'complete',startedAt:laneStart,finishedAt:new Date().toISOString(),review:outcome.value,call:outcome.record};
      write(`${variant}-${arm}-${role}.json`,record); return [role,record];
    } catch(error) {
      const record={status:'error',startedAt:laneStart,finishedAt:new Date().toISOString(),review:null,call:mod.judgeCallRecordFrom(error),error:String(error)};
      write(`${variant}-${arm}-${role}.json`,record); return [role,record];
    }
  })));
  const result={variant,arm,startedAt,finishedAt:new Date().toISOString(),elapsedMs:Date.now()-start,expectedBlockingRefs:expected[variant],reviews,oracle:'unreached',oracleError:null};
  if(Object.values(reviews).every(r=>r.status==='complete')) {
    try {
      for (const r of Object.values(reviews)) {
        assert.equal(r.call.backend,'codex'); assert.equal(r.call.model,'gpt-5.6-luna'); assert.equal(r.call.effort,'xhigh'); assert.equal(r.call.fallback,undefined);
        if(variant!=='visual') assert.ok(r.call.activity?.commands?.length>0,'must read actual source');
      }
      mod.assertReviewBlockingRefs({findings:Object.values(reviews).flatMap(r=>r.review.findings)},expected[variant],fixture.material.contract.decisions.map(d=>d.id));
      result.oracle='pass';
    }catch(error){result.oracle='fail';result.oracleError=String(error);}
  }
  // External oracle results are never retry feedback to a reviewer.
  results.push(result);write('results.json',results);event({type:'case-end',variant,arm,elapsedMs:result.elapsedMs,oracle:result.oracle,error:result.oracleError,reviewStatuses:Object.fromEntries(Object.entries(reviews).map(([role,r])=>[role,r.status]))});
}
write('execution-finished.json',{at:new Date().toISOString(),cases:results.length,oraclePasses:results.filter(r=>r.oracle==='pass').length});
