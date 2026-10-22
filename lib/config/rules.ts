// 아르고스의 점수·등급·알림 규칙 숫자를 한곳에 모은 설정 모듈.
// Design Ref: §1 "규칙은 한곳에" — 숫자를 바꿀 때는 이 파일만 고치고, 값은 PRD.md·DESIGN.md와 같게 유지한다.
// 이 파일은 값만 담는다. 계산 로직은 lib/pipeline에서 이 값을 가져다 쓴다.

/** 4단계 등급 (낮은 순) */
export const GRADES = ["관심", "주의", "경계", "심각"] as const;
export type Grade = (typeof GRADES)[number];

/** 출처 신뢰도 등급 — 1: 공식 발표, 2: 통신사·연구기관·주요 경제지, 3: 일반 미디어 (PRD 5번 Must① 규칙 1) */
export type SourceTier = 1 | 2 | 3;

/** 영향도를 보는 한국 유입 6개 경로 (PRD 3-2) */
export const IMPACT_CHANNELS = [
  "수출·통상",
  "에너지 가격",
  "환율·자본 유출",
  "금융시장 전염",
  "공급망",
  "교민·안보",
] as const;
export type ImpactChannel = (typeof IMPACT_CHANNELS)[number];

export const RULES = {
  /** 수집 주기 (PRD 6번, DESIGN 14장) */
  collection: {
    intervalMinutes: 60,
    /** 정각 혼잡을 피해 매시 7분에 실행 */
    cronMinute: 7,
    /** 새 자료 공개 후 이슈 카드 반영 목표 (PRD 3-3) */
    reflectWithinHours: 3,
    /** 실행이 이만큼 멈추면 화면에 빨간 경고 (DESIGN 4.2) */
    staleWarningHours: 2,
    /** 원문 전문 대신 저장하는 짧은 발췌의 최대 글자 수 (PRD 7번) */
    excerptMaxChars: 300,
    /** 출처 하나를 기다리는 최대 시간 */
    fetchTimeoutMs: 15000,
    /** 수집기임을 밝히는 이름 — 브라우저인 척하지 않는다 */
    userAgent: "ArgosRiskMonitor/0.1 (personal research; contact via repository owner)",
  },

  /** 요약·묶기 (PRD Must① 규칙 2·3·6) */
  issue: {
    summaryMaxSentences: 3,
    /** 이 확신도 미만이면 새 이슈 카드를 만든다 */
    sameIssueMinConfidence: 0.7,
    /** 새 자료 없이 이 기간이 지난 '관심' 이슈는 보관 */
    archiveAfterIdleDays: 14,
    /** 묶기 비교 대상에 넣을 보관 이슈의 기간 (DESIGN 7.1) */
    reopenArchivedWithinDays: 90,
  },

  /** 점수 평가 (PRD 3-2, Must① 규칙 4, DESIGN 6장) */
  scoring: {
    /** 같은 이슈를 평가하는 횟수 — 중앙값 사용 */
    evaluationRuns: 5,
    axisMax: 100,
    /** 근거가 없는 축의 점수 */
    noEvidenceAxisScore: 0,
  },

  /** 영향도 계산 (DESIGN 6.1) */
  impact: {
    channelMax: 5,
    /** 기본 점수 = 최고 경로 점수 × 14 + 나머지 경로 합 × 2 */
    topChannelWeight: 14,
    otherChannelWeight: 2,
    /** 시스템 중요국이 진원이거나 한국이 직접 진원일 때 가산점 */
    systemicBonus: 10,
    systemicOrigins: ["미국", "중국", "유로존", "일본", "한국"],
    /** Must② 규칙 5: 한국 영향에 쓰는 경로의 최소 점수 */
    koreaImpactMinChannelScore: 2,
  },

  /** 가능성 계산 (DESIGN 6.2) */
  likelihood: {
    pressureMax: 40,
    /** 예정된 계기: 남은 일수 이내면 해당 점수 (가까운 것부터 확인) */
    scheduledTrigger: [
      { withinDays: 7, score: 30 },
      { withinDays: 30, score: 20 },
      { withinDays: 90, score: 10 },
    ],
    triggerSignalScore: 10,
    triggerSignalMax: 30,
  },

  /** 속도 계산 — AI 없이 자료 수로 계산 (DESIGN 6.3) */
  velocity: {
    windowHours: 6,
    baselineDays: 7,
    /** 기준선 최소값 — 돌발 사건과 새 이슈도 계산되게 */
    baselineMin: 1,
    /** 출처 등급별 자료 1건의 가중치, "(카더라)"는 0 */
    tierWeight: { 1: 1.5, 2: 1.2, 3: 1.0 } satisfies Record<SourceTier, number>,
    rumorWeight: 0,
    /** 가중 자료 수가 이보다 적으면 속도 점수 상한을 둔다 */
    minCountForHighScore: 3,
    lowCountMaxScore: 30,
    /** 비율(최근 ÷ 기준선)이 upTo 미만이면 score — 마지막 칸은 그 이상 전부 */
    ratioToScore: [
      { upTo: 1.5, score: 10 },
      { upTo: 3, score: 30 },
      { upTo: 6, score: 50 },
      { upTo: 12, score: 70 },
      { upTo: 24, score: 85 },
      { upTo: Infinity, score: 100 },
    ],
  },

  /** 종합 점수와 등급 (PRD 3-2, Must① 규칙 1, DESIGN 6.4) */
  grade: {
    /** 각 등급이 시작하는 점수 (종합 점수 = 영향도 × max(가능성, 속도) ÷ 100) */
    minScore: { 관심: 0, 주의: 40, 경계: 60, 심각: 80 } satisfies Record<Grade, number>,
    /** 등급 경계 ±이 점수 안이면 '경계선' 표시 */
    borderlineMargin: 3,
    /** 3등급 출처만 있거나 1·2등급 근거가 없으면 '심각' 불가 — 최대 점수 */
    tier3OnlyMaxScore: 79,
    /** '심각' 판정에 필요한 1·2등급 근거 수 */
    severeMinTier12Evidence: 1,
    /** 등급 하향은 연속 실행 이만큼 확인 후 반영 */
    downgradeConfirmRuns: 2,
  },

  /** 시나리오 (PRD Must② 규칙 2~6) */
  scenario: {
    /** 시나리오를 만드는 최소 등급 */
    minGrade: "경계" satisfies Grade,
    kinds: ["기본", "악화", "극단"],
    probabilityUnit: 1,
    probabilityTotal: 100,
    minSignalsPerScenario: 2,
    checklistMin: 3,
    checklistMax: 5,
  },

  /** 알림 (PRD Must② 규칙 1·7·8·9·10, DESIGN 7.2~7.3) */
  alert: {
    /** 판정 후 발송까지 목표 시간 */
    sendWithinMinutes: 10,
    /** 알림에 필요한 1·2등급 출처 수 */
    minTier12Sources: 1,
    briefingLines: 3,
    briefingLineMaxChars: 60,
    /** 같은 등급으로 다시 올라온 경우 재알림 대기 시간 */
    sameGradeCooldownHours: { 경계: 24, 심각: 6 },
    /** '경계' 알림 야간 보류 (한국 시간, 시작 시각 이상 ~ 끝 시각 미만) */
    nightHold: { startHourKst: 23, endHourKst: 7, appliesTo: "경계" satisfies Grade },
    /** 하향 알림을 보내는 등급 */
    downgradeAlertFrom: "심각" satisfies Grade,
    /** 평상시 주간 알림 목표 상한 (PRD 3-3) */
    weeklyTargetMax: 3,
    disclaimer: "투자 권유가 아닌 참고 정보",
  },

  /** AI 호출 (DESIGN 10장) */
  ai: {
    maxRetries: 3,
  },

  /** 평가 기준표 주간 보완 (PRD Must① 규칙 8, DESIGN 7.6) */
  rubric: {
    /** 재검증 때 평온 기간에서 무작위로 뽑는 기간 */
    calmSampleDays: 14,
    /** 재검증이 이 시간을 넘으면 중단하고 기존 버전 유지 */
    maxRerunHours: 5,
  },

  /** 과거 검증 통과 기준 (PRD 3-1·3-2·3-3) */
  validation: {
    /** 놓침 판정: T0 후 이 시간 안에 '경계' 이상이 되어야 함 */
    missWithinHoursAfterT0: 24,
    /** 4개 사례 중 목표 선행 시간을 지켜야 하는 수 */
    minCasesOnTarget: 3,
    calmPeriod: { start: "2024-01-01", end: "2024-03-31", timezone: "Asia/Seoul" },
    maxFalseAlarmsPerWeek: 1,
    maxScoreStdDev: 5,
    /** 5번 모두 같은 등급인 이슈 비율 */
    minSameGradeRatio: 0.9,
    /** 작성자 판단과의 등급 일치율, 불일치 허용 단계 */
    minHumanAgreement: 0.8,
    maxHumanGradeGap: 1,
    humanLabelIssueCount: 20,
    /** 이슈 묶기 정확도 표본과 목표 */
    clusteringSampleSize: 50,
    minClusteringAccuracy: 0.9,
  },

  /** 화면 로그인 (DESIGN 9장) */
  login: {
    maxFailedAttempts: 5,
    lockMinutes: 15,
  },
} as const;
