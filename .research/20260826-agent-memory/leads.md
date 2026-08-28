# Lead Ledger

형식: - [open|done|dup|dead] <lead> — WHY <이유> — ANGLE <추적 방법>  (from: waveN/axis-M)

- [open] Copilot citation-revalidation이 실제로 stale 사실을 줄이는가 — WHY 메모리를 "낡음"이 아니라 "반증가능"하게 만드는 유일한 출시 기제, 우리 verify 게이트의 diff 핀과 같은 발상 — ANGLE copilot memory citation validation 평가, GitHub 커뮤니티 #184415  (from: wave1/axis-4)
- [open] Anthropic이 feature list를 Markdown 대신 JSON으로 바꾼 이유(모델이 JSON을 덜 덮어씀) — WHY 마크다운 메모리 트렌드 전체를 가로지르는 포맷 수준 변조내성 주장 — ANGLE anthropics/cwc-long-running-agents 커밋/이슈, agent file format tamper resistance  (from: wave1/axis-4)
- [open] 메모리가 유발하는 sycophancy / persona drift - 기억이 판단력을 갉아먹는가 — WHY 모든 벤치마크가 recall만 재고 judgment 저하는 안 잼. 검증 하네스에는 치명적 — ANGLE arXiv 2605.09863 persona drift, memory bias accumulation agent judgment  (from: wave1/axis-4)
- [open] claude-mem 91.8k 스타인데 벤치마크가 전무 — WHY 정확히 우리 워크로드용 최다 설치 시스템, "10배 토큰 절약" 전부 자가보고 — ANGLE docs.claude-mem.ai/architecture, repo 이슈 58개 신뢰성 리포트  (from: wave1/axis-4)
- [open] AMA-Bench: 대화 중심 벤치마크는 기질 자체가 틀렸다(에이전트 메모리는 상태/행동/관찰/툴출력의 궤적) — WHY 맞다면 벤더 수치가 코딩 하네스로 전이될 여지가 더 줄어듦 — ANGLE arXiv 2602.22769 AMA-Agent 인과그래프 절, LongMemEval-V2  (from: wave1/axis-4)
- [open] MemBench(2506.21605) / From Recall to Forgetting(2604.20006) — 거부된 쓰기(precision on non-storage)를 채점하는가 — WHY True Memory가 "존재하지 않는다"고 한 계측기. 있으면 이 분야 최대 측정 구멍이 닫힘 — ANGLE 두 초록 fetch, 저장 안 한 것에 대한 점수 항목 grep  (from: wave1/axis-3)
- [open] EverMemOS가 독립 매칭 심판에서 LoCoMo 94.5% — WHY 벤더 자가보고를 독립 측정이 넘어선 유일 사례, 진짜 SOTA거나 심판 인플레 사례 — ANGLE EverMemOS arxiv, MemoryAgentBench/HaluMem 등재 여부 교차확인  (from: wave1/axis-3)
- [open] Titans ablation에서 weight decay가 surprise보다 기여 큼 — WHY surprise를 내세운 아키텍처에서조차 망각이 더 중요하면 "무엇을 담을까" 프레임 자체가 덜 중요해짐 — ANGLE 2501.00663 ablation 표, MIRAS 후속  (from: wave1/axis-3)
- [dup]  BEAM 원 논문 per-category (contradiction resolution) — axis-4에서 이미 커버, 수치 확보됨
- [open] Chroma: 뒤섞은 haystack이 일관된 것보다 18개 모델 전부에서 낫다 — WHY 모든 메모리 시스템이 검색 결과를 시간순/관련도순으로 재조립하는데, 국소 일관성이 오히려 해롭다면 조립 단계가 정확도를 갉고 있음 — ANGLE context assembly order shuffle interleave, Chroma 외부 재현 여부  (from: wave1/axis-3)
- [open] latent memory (Generate/Reuse/Transform) - 텍스트도 가중치도 아닌 제3의 형태 — WHY 모든 분류 논쟁에 안 보이는데 서베이들은 retrieval→generation 전환이 여기서 일어날 거라 봄 — ANGLE 2512.13564 §3.3, MemGen, TokMem  (from: wave1/axis-1)
- [open] RL로 학습된 메모리 관리 정책 (Mem-α, Memory-R1, MEM1, AtomMem) — WHY 사실이면 현재의 외부 아키텍처 설계공간 전체가 과도기 비계가 됨 — ANGLE 2602.06052 §5.3  (from: wave1/axis-1)
- [open] 메모리 포이즈닝과 출처(provenance)를 설계 제약으로 — WHY "주입 저항성은 출처 경계가 표현에서 살아남는지에 달렸다"(2607.21962). 표현 선택이 곧 보안 선택 — ANGLE InjecMEM 2608.23471, MemGuard 2608.21867, 2604.16548  (from: wave1/axis-1)
- [open] 멀티에이전트 공유 메모리 거버넌스 — WHY 모든 분류가 단일 에이전트 전제. 두 에이전트가 한 저장소를 쓰는 순간 쓰기 충돌·믿음 분기·소유권 문제. 이 저장소는 실제로 동시 세션 환경 — ANGLE 2602.06052 §4.2, G-Memory, MELD 2608.16357  (from: wave1/axis-1)
- [dup]  OpenClaw의 MEMORY.md — axis-4에서 이미 커버(모델이 쓰기로/읽기로 결정해야만 동작, 보장 없음)
- [open] 메모리 포이즈닝 2026 폭발 (InjecMEM, MemSecBench, MemGuard, Memory Contagion) — WHY Park 2023이 이미 memory hacking을 지목. 영속 메모리는 프롬프트 인젝션과 질적으로 다른 위협(persistence/statefulness/propagation) — ANGLE cs.CR + agent memory poisoning 2026  (from: wave1/axis-2)  [주: wave1/axis-1의 provenance 리드와 부분 중복]
- [open] 코딩 에이전트 전용 메모리 (Letta Context Repositories/Trajectory/Skill Learning, AgentArtifactCorpus 54,628 저장소) — WHY 우리 도메인과 정확히 겹치고, exit-code라는 강한 오라클이 있어 이 계보에서 유일하게 신뢰 가능한 평가가 가능한 영역. 핵심 질문: SWE-bench/Terminal-Bench에서 메모리 유무의 델타를 실측한 논문이 있는가 — ANGLE letta.com/blog, TRACE 2608.22793, CONTRAMEM 2608.22533  (from: wave1/axis-2)
- [done] 메모리 유발 sycophancy / persona drift — 6개 벤치마크 확인, 전제였던 "아무도 안 잰다"는 반증됨. 진짜 공백은 코드리뷰/검증 에이전트 (arXiv "code review"+"sycophancy" 0건)
- [open] Compositional Generalization over Time (2604.27707) - "맥락적 에이전트 메모리는 메모지 진짜 기억이 아니다" — WHY 더 깊은 질문은 "메모리가 판단을 해치는가"가 아니라 "경험으로 능력이 실제로 느는가, 아니면 메모만 쌓이는가" — ANGLE 2604.27707 v2 일반화 상한 증명  (from: wave2)
- [open] MemGhost / sleeper memory poisoning (2605.15338) — WHY 사고로 일어나는 모든 실패 양상에는 의도적 쌍둥이가 있음. 파일 기반 메모리는 사람이 읽고 diff로 보이니 공격면이 다른가 — ANGLE arxiv memory poisoning agent 최신순  (from: wave2)
