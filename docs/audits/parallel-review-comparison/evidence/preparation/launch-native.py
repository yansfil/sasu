import datetime,json,os,pathlib,subprocess,sys,time
arm=sys.argv[1]
assert arm in ('unified','split')
root=pathlib.Path('/private/tmp/sasu-parallel-review-prep')
launch=root/'native-sessions'/arm
out=root/('native-'+arm)
out.mkdir(exist_ok=True)
argv=['/Users/hoyeonlee/Library/pnpm/codex','exec','--model','gpt-5.6-sol','-c','model_reasoning_effort="medium"','--sandbox','danger-full-access','--skip-git-repo-check','--json','-C',str(launch),'-o',str(out/'last-message.txt'),'-']
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
start={'arm':arm,'startedAt':now(),'argv':argv,'pane':os.environ.get('HERDR_PANE_ID'),'role':os.environ.get('SASU_HERDR_ROLE'),'persistentSession':True}
with (out/'start.json').open('x') as f: json.dump(start,f,indent=2)
t=time.monotonic()
with (root/('prompt-'+arm+'.txt')).open('rb') as inp,(out/'stdout.jsonl').open('wb') as stdout,(out/'stderr.log').open('wb') as stderr:
 result=subprocess.run(argv,stdin=inp,stdout=stdout,stderr=stderr,cwd=launch)
(out/'end.json').write_text(json.dumps({'endedAt':now(),'exitCode':result.returncode,'elapsedSeconds':time.monotonic()-t},indent=2)+'\n')
sys.exit(result.returncode)
