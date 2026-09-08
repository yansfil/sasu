import datetime,json,pathlib
root=pathlib.Path('/private/tmp/sasu-parallel-review-prep')
execution=json.loads((root/'execution.json').read_text())
def ts(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
def union(intervals):
    merged=[]
    for start,end in sorted(intervals):
        if end<=start: continue
        if merged and start<=merged[-1][1]: merged[-1][1]=max(end,merged[-1][1])
        else: merged.append([start,end])
    return sum(b-a for a,b in merged)
out={'method':'Phase elapsed windows are disjoint, not estimates of active model work. Unattributed time is the remainder outside observed tool-call intervals and the recorded verify execution. It is not classified as waste. Judge record durations include preflight overhead; raw process-only timings are available separately for quality fixtures.','arms':{}}
for arm,a in execution['arms'].items():
    state=json.loads((pathlib.Path(a['coordinates']['runDir'])/'state.json').read_text())
    receipt=json.loads((pathlib.Path(a['coordinates']['runDir'])/'receipt.json').read_text())
    calls={}; events=[]; intervals=[]
    for n,line in enumerate(pathlib.Path(a['transcript']).read_text().splitlines(),1):
        d=json.loads(line); p=d['payload']
        if d['type']!='response_item': continue
        if p.get('type') in ['function_call','custom_tool_call']:
            c={'line':n,'start':ts(d['timestamp']),'startedAt':d['timestamp'],'input':str(p.get('input',p.get('arguments','')))}
            calls[p['call_id']]=c;events.append(c)
        if p.get('type') in ['function_call_output','custom_tool_call_output'] and p.get('call_id') in calls:
            c=calls[p['call_id']];c['end']=ts(d['timestamp']);c['outputLine']=n;c['output']=str(p.get('output',''));intervals.append((c['start'],c['end']))
    handoff=ts(a['nativeStart']['startedAt']);created=ts(state['createdAt']);end=ts(receipt['completedAt'])
    attempts=state['verificationAttempts'];assert len(attempts)==1
    v=attempts[0];vs=ts(v['startedAt']);ve=ts(v['finishedAt']);intervals.append((vs,ve))
    qa=next(c['start'] for c in events if c['start']>created and ('node --check ' in c['input'] or 'node --input-type=module' in c['input']))
    failed=[c for c in events if ' implement start ' in c['input'] and 'path escapes project root' in c.get('output','')]
    recovery=created-failed[0]['start'] if failed else 0
    reviews=v.get('reviews') or {'unified':v['review']}
    review_intervals=[(ts(q['startedAt']),ts(q['finishedAt'])) for q in reviews.values()]
    mechanics=[(ts(q['startedAt']),ts(q['finishedAt'])) for q in v['mechanical']]
    review_union=union(review_intervals);mechanical_union=union(mechanics)
    phases={'preparation':created-handoff-recovery,'startRecovery':recovery,'initialImplementationWindow':qa-created,'focusedQaWindow':vs-qa,'requiredSuites':mechanical_union,'routineReview':review_union,'otherVerification':ve-vs-review_union-mechanical_union,'productRepair':0,'passToReceipt':end-ve}
    assert abs(sum(phases.values())-(end-handoff))<0.01
    observed=union([(max(s,handoff),min(e,end)) for s,e in intervals])
    out['arms'][arm]={'sessionId':a['sessionId'],'handoffAt':a['nativeStart']['startedAt'],'stateCreatedAt':state['createdAt'],'receiptCompletedAt':receipt['completedAt'],'handoffToReceiptSeconds':end-handoff,'stateToReceiptSeconds':end-created,'phaseSeconds':phases,'observedToolOrVerifySeconds':observed,'unattributedSeconds':end-handoff-observed,'routineReviewSumSeconds':sum(e-s for s,e in review_intervals),'routineReviewOverlapSeconds':sum(e-s for s,e in review_intervals)-review_union,'roleRecords':len(reviews),'answeringAttempts':sum(q['judge']['attempts'] for q in reviews.values()),'verifyRounds':len(attempts),'eventIndex':[{'line':c['line'],'outputLine':c.get('outputLine'),'startedAt':c['startedAt'],'toolDurationSeconds':c.get('end',c['start'])-c['start'],'input':c['input']} for c in events if c['start']<=end]}
(root/'phase-measurements.json').write_text(json.dumps(out,indent=2,ensure_ascii=False)+'\n')
for arm,a in out['arms'].items(): print(arm,json.dumps({k:v for k,v in a.items() if k!='eventIndex'},ensure_ascii=False,indent=2))
