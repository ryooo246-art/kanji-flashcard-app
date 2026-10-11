/* ==========================================================
   かんじカード - メインロジック
   version: v2.0 (2026-10-04)
   v2.0: カタカナの行チェック / 漢字の4択(音声認識とラジオ切替) / 選択肢の自動生成
   ========================================================== */
const APP_VERSION = 'v2.0';

const state = {
  allWords: [],          // CSV全件 [{grade,kanji,word,reading}]
  wordsByGrade: {},       // カテゴリid -> [words]
  queue: [],              // 今回の出題キュー
  qIndex: 0,
  correctCount: 0,
  stars: 0,
  currentAttemptFails: 0,
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  orderMode: 'random',
  answerMode: 'choice',    // 'choice'(4択) | 'voice'(音声認識)  ※漢字の学年のみ
  katakanaRows: ['a-sa', 'ta-ha', 'ma-n'], // 出題するカタカナの行(チェック済み)
  _qMode: 'voice',         // 今の問題の出題形式: 'kana' | 'choice' | 'voice'
  mistakes: {},            // "grade:kanji" -> 間違えた回数(localStorageに保存)
};

// 出題カテゴリ一覧。fileが無いものは自動的に「じゅんびちゅう」表示になる。
const CATEGORIES = [
  { id: 'hiragana', label: 'ひらがな', file: 'data/hiragana.csv' },
  { id: 'katakana', label: 'カタカナ', file: 'data/katakana.csv' },
  { id: 1, label: '1年生', file: 'data/grade1.csv' },
  { id: 2, label: '2年生', file: 'data/grade2.csv' },
  { id: 3, label: '3年生', file: 'data/grade3.csv' },
  { id: 4, label: '4年生', file: 'data/grade4.csv' },
  { id: 5, label: '5年生', file: 'data/grade5.csv' },
  { id: 6, label: '6年生', file: 'data/grade6.csv' },
];
const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label]));
CATEGORY_LABELS.review = '🔁 にがてな かんじ';

// カタカナの出題範囲(メイン画面のチェックボックスと対応)
const KATAKANA_ROWS = [
  { id: 'a-sa', label: 'ア〜サ行', chars: 'アイウエオカキクケコサシスセソ' },
  { id: 'ta-ha', label: 'タ〜ハ行', chars: 'タチツテトナニヌネノハヒフヘホ' },
  { id: 'ma-n', label: 'マ〜ン', chars: 'マミムメモヤユヨラリルレロワヲン' },
];

const PRAISE_WORDS = [
  'すごい！', 'やったね！', 'かんぺき！', 'その ちょうし！', 'てんさい！',
  'すばらしい！', 'よくできました！', 'ピカピカ はなまる！', 'かっこいい！'
];

const GENTLE_WORDS = [
  'おしい！もういちど よんでみよう', 'もうすこし！ゆっくりで いいよ',
  'ちがう かんじだったかな？もういっかい！', 'だいじょうぶ、もう1回チャレンジ！'
];

/* ---------------- CSV読み込み ---------------- */
async function loadData(){
  state.allWords = [];
  for(const cat of CATEGORIES){
    if(!cat.file) continue;
    try{
      const res = await fetch(cat.file);
      if(!res.ok) continue;
      const text = await res.text();
      const lines = text.trim().split('\n').slice(1); // ヘッダー除外
      for(const rawLine of lines){
        const line = rawLine.replace(/\r$/, '');
        if(!line.trim()) continue;
        // 5列目 choices は任意。「まぎらわしい読み」を | 区切りで書くと4択の不正解に使われる
        const [g, kanji, word, reading, choicesRaw] = line.split(',');
        // 数字にできるものは学年(数値)、できないものはカテゴリ名(ひらがな等)のまま保持
        const gradeId = /^\d+$/.test(g) ? Number(g) : g;
        const choices = choicesRaw
          ? choicesRaw.split('|').map(x => x.trim()).filter(Boolean)
          : null;
        state.allWords.push({ grade: gradeId, kanji, word, reading, choices });
      }
    }catch(e){
      console.warn(`${cat.file} の読み込みに失敗しました`, e);
    }
  }
  state.wordsByGrade = {};
  for(const w of state.allWords){
    if(!state.wordsByGrade[w.grade]) state.wordsByGrade[w.grade] = [];
    state.wordsByGrade[w.grade].push(w);
  }
}

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

/* ---------------- 画面1: 学年セットアップ ---------------- */
function renderGradeList(){
  const list = document.getElementById('grade-list');
  list.innerHTML = '';

  // 苦手復習モード(これまでに間違えた記録があるときだけ選べる)
  const reviewKanjiCount = Object.values(state.mistakes).filter(c => c > 0).length;
  const reviewItem = document.createElement('div');
  reviewItem.className = 'grade-item' + (reviewKanjiCount > 0 ? '' : ' disabled');
  reviewItem.innerHTML = `
    <input type="checkbox" id="grade-review" ${reviewKanjiCount > 0 ? '' : 'disabled'}>
    <label for="grade-review">
      <span>🔁 にがてな かんじ</span>
      ${reviewKanjiCount > 0 ? `<span class="badge-count">${reviewKanjiCount}字</span>` : `<span class="badge-soon">きろくなし</span>`}
    </label>`;
  list.appendChild(reviewItem);
  if(reviewKanjiCount > 0){
    const cb = reviewItem.querySelector('input');
    cb.addEventListener('change', ()=>{
      reviewItem.classList.toggle('checked', cb.checked);
      updateStartButton();
    });
  }

  for(const cat of CATEGORIES){
    const has = !!state.wordsByGrade[cat.id] && state.wordsByGrade[cat.id].length>0;
    const item = document.createElement('div');
    item.className = 'grade-item' + (has ? '' : ' disabled');
    const kanjiCount = has ? new Set(state.wordsByGrade[cat.id].map(w=>w.kanji)).size : 0;
    const unit = (cat.id === 'hiragana' || cat.id === 'katakana') ? '文字' : '字';
    item.innerHTML = `
      <input type="checkbox" id="grade-${cat.id}" ${has? '' : 'disabled'} ${cat.id===1 && has ? 'checked' : ''}>
      <label for="grade-${cat.id}">
        <span>${cat.label}</span>
        ${has ? `<span class="badge-count">${kanjiCount}${unit}</span>` : `<span class="badge-soon">じゅんびちゅう</span>`}
      </label>`;
    list.appendChild(item);
    if(has){
      const cb = item.querySelector('input');
      cb.addEventListener('change', ()=>{
        item.classList.toggle('checked', cb.checked);
        updateStartButton();
      });
      if(cb.checked) item.classList.add('checked');
    }

    // カタカナだけ、出題する行を選ぶチェックボックスを表示する
    if(cat.id === 'katakana' && has){
      const sub = document.createElement('div');
      sub.className = 'sub-options hidden';
      sub.id = 'katakana-rows';
      sub.innerHTML = KATAKANA_ROWS.map(r => `
        <label class="sub-check">
          <input type="checkbox" class="kata-row-cb" value="${r.id}" ${state.katakanaRows.includes(r.id) ? 'checked' : ''}>
          <span>${r.label}</span>
        </label>`).join('');
      list.appendChild(sub);

      const kataCb = item.querySelector('input');
      kataCb.addEventListener('change', ()=>{ sub.classList.toggle('hidden', !kataCb.checked); });
      sub.querySelectorAll('.kata-row-cb').forEach(rcb => {
        rcb.addEventListener('change', ()=>{
          state.katakanaRows = Array.from(sub.querySelectorAll('.kata-row-cb'))
            .filter(c => c.checked).map(c => c.value);
          store.set(KATA_ROWS_STORE, JSON.stringify(state.katakanaRows));
          updateStartButton();
        });
      });
    }
  }

  const resetLink = document.getElementById('reset-mistakes-link');
  resetLink.classList.toggle('hidden', reviewKanjiCount === 0);

  updateStartButton();
}

function getSelectedGrades(){
  const grades = [];
  const reviewCb = document.getElementById('grade-review');
  if(reviewCb && !reviewCb.disabled && reviewCb.checked) grades.push('review');
  for(const cat of CATEGORIES){
    const cb = document.getElementById(`grade-${cat.id}`);
    if(cb && !cb.disabled && cb.checked) grades.push(cat.id);
  }
  return grades;
}

function updateStartButton(){
  const grades = getSelectedGrades();
  const btn = document.getElementById('btn-start');
  const hint = document.getElementById('setup-hint');
  const kataNoRow = grades.includes('katakana') && state.katakanaRows.length === 0;
  btn.disabled = grades.length === 0 || kataNoRow;
  if(grades.length === 0){
    hint.textContent = 'がくねんに チェックをいれてね';
  }else if(kataNoRow){
    hint.textContent = 'カタカナの ぎょうに チェックをいれてね';
  }else{
    hint.textContent = `${grades.map(g=>CATEGORY_LABELS[g]).join('・')} で スタートできるよ`;
  }
}

function getSelectedKatakanaChars(){
  const set = new Set();
  for(const r of KATAKANA_ROWS){
    if(state.katakanaRows.includes(r.id)) r.chars.split('').forEach(c => set.add(c));
  }
  return set;
}

/* ---------------- 出題キュー作成 ---------------- */
function mistakeKey(w){ return `${w.grade}:${w.kanji}`; }

function getReviewWords(){
  const entries = Object.entries(state.mistakes).filter(([,c]) => c > 0);
  entries.sort((a,b) => b[1]-a[1]); // 苦手なもの(回数が多いもの)を先頭に
  const result = [];
  for(const [key] of entries){
    const idx = key.indexOf(':');
    const gradeStr = key.slice(0, idx);
    const kanji = key.slice(idx+1);
    const grade = /^\d+$/.test(gradeStr) ? Number(gradeStr) : gradeStr;
    result.push(...state.allWords.filter(w => w.grade === grade && w.kanji === kanji));
  }
  return result;
}

function buildQueue(){
  const grades = getSelectedGrades();
  const normalGrades = grades.filter(g => g !== 'review');
  let words = state.allWords.filter(w => normalGrades.includes(w.grade));
  // カタカナは、チェックが入っている行の文字だけ出題する
  const kataChars = getSelectedKatakanaChars();
  words = words.filter(w => w.grade !== 'katakana' || kataChars.has(w.kanji));

  if(grades.includes('review')){
    const seen = new Set(words.map(w => w.grade+':'+w.word));
    for(const w of getReviewWords()){
      const key = w.grade+':'+w.word;
      if(!seen.has(key)){ words.push(w); seen.add(key); }
    }
  }

  // 漢字ごとにグループ化 -> 漢字の順番をシャッフル(または維持) -> 各漢字内の単語もシャッフル
  const byKanji = {};
  const kanjiOrder = [];
  for(const w of words){
    if(!byKanji[w.kanji]){ byKanji[w.kanji] = []; kanjiOrder.push(w.kanji); }
    byKanji[w.kanji].push(w);
  }
  let order = kanjiOrder;
  if(state.orderMode === 'random') order = shuffle(kanjiOrder);

  const queue = [];
  for(const k of order){
    const ws = state.orderMode === 'random' ? shuffle(byKanji[k]) : byKanji[k];
    queue.push(...ws);
  }
  return queue;
}

/* ---------------- 画面切り替え ---------------- */
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

/* ---------------- ゲーム進行 ---------------- */
function startSession(){
  state.orderMode = document.getElementById('order-mode').value;
  const modeRadio = document.querySelector('input[name="answer-mode"]:checked');
  state.answerMode = modeRadio ? modeRadio.value : 'choice';
  state.queue = buildQueue();
  state.qIndex = 0;
  state.correctCount = 0;
  state.currentAttemptFails = 0;
  showScreen('screen-game');
  renderQuestion();
}

function renderQuestion(){
  if(state.qIndex >= state.queue.length){
    finishSession();
    return;
  }
  const q = state.queue[state.qIndex];
  const isKanaQuiz = (q.grade === 'hiragana' || q.grade === 'katakana');
  // kana: 音声を聞いて文字を選ぶ / choice: 単語を見て読みを選ぶ / voice: 単語を見て声で答える
  const mode = isKanaQuiz ? 'kana' : (state.answerMode === 'voice' ? 'voice' : 'choice');
  state._qMode = mode;
  state._quizAnswered = false;

  document.getElementById('flash-card').classList.toggle('hidden', mode === 'kana');
  document.getElementById('kana-quiz').classList.toggle('hidden', mode !== 'kana');
  document.getElementById('reading-quiz').classList.toggle('hidden', mode !== 'choice');
  document.getElementById('mic-area').classList.toggle('hidden', mode !== 'voice');
  document.getElementById('btn-hint').classList.toggle('hidden', mode === 'kana');
  document.getElementById('btn-hint').disabled = false;

  if(mode === 'kana'){
    buildQuizChoices(q);
    speakReading(q.reading);
  }else{
    const badge = document.getElementById('kanji-badge');
    badge.textContent = q.kanji;
    badge.classList.toggle('hidden', q.kanji === q.word);
    document.getElementById('word-display').textContent = q.word;
    if(mode === 'choice') buildReadingChoices(q);
  }

  const hint = document.getElementById('reading-hint');
  hint.textContent = q.reading;
  hint.classList.add('hidden');
  document.getElementById('feedback-bubble').classList.add('hidden');
  state.currentAttemptFails = 0;
  state.hintRevealCount = 0;

  const total = state.queue.length;
  document.getElementById('progress-label').textContent = `${state.qIndex} / ${total}`;
  document.getElementById('progress-fill').style.width = `${(state.qIndex/total*100).toFixed(1)}%`;
  document.getElementById('star-count').textContent = state.stars;

  updateMascotGrowth();

  const card = document.getElementById('flash-card');
  card.classList.remove('shake-soft');
  void card.offsetWidth; // reflow でアニメ再トリガー
}

/* ---------------- かなクイズ(音声を聞いて4択) ---------------- */
function speakReading(text){
  if(!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = 0.85;
  window.speechSynthesis.speak(u);
}

function buildQuizChoices(q){
  const container = document.getElementById('quiz-choices');
  container.innerHTML = '';
  let pool = (state.wordsByGrade[q.grade] || []).map(w => w.kanji);
  if(q.grade === 'katakana'){
    // 不正解の候補も、チェックが入っている行の中から選ぶ
    const allowed = getSelectedKatakanaChars();
    const filtered = pool.filter(k => allowed.has(k) || k === q.kanji);
    if(new Set(filtered).size >= 4) pool = filtered;
  }
  const uniquePool = Array.from(new Set(pool)).filter(k => k !== q.kanji);
  const distractors = shuffle(uniquePool).slice(0, 3);
  const options = shuffle([q.kanji, ...distractors]);
  for(const opt of options){
    addChoiceButton(container, opt, opt === q.kanji, '');
  }
}

function addChoiceButton(container, label, isCorrect, extraClass){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'quiz-choice-btn' + (extraClass ? ' ' + extraClass : '');
  btn.textContent = label;
  btn.dataset.correct = isCorrect ? '1' : '0';
  btn.addEventListener('click', ()=> handleChoiceAnswer(btn));
  container.appendChild(btn);
}

function handleChoiceAnswer(btnEl){
  if(state._quizAnswered) return;
  if(btnEl.dataset.correct === '1'){
    state._quizAnswered = true;
    btnEl.classList.add('correct');
    document.querySelectorAll('.quiz-choice-btn').forEach(b => b.disabled = true);
    onCorrect();
  }else{
    btnEl.classList.add('wrong');
    btnEl.disabled = true;
    onIncorrect('');
  }
}

/* ---------------- 漢字の4択(実在する言葉の読みから選択肢を作る) ---------------- */
// 全学年の単語から「読みの一覧」と「単語→正しい読みの一覧」を一度だけ作る。
// 選んだ学年だけでなく全学年から集めるので、1年生だけを選んでも候補が足りる。
function ensureReadingIndex(){
  if(state._readingIndex) return;
  const readings = [];
  const seen = new Set();
  const wordReadings = new Map();
  for(const w of state.allWords){
    if(w.grade === 'hiragana' || w.grade === 'katakana') continue;
    if(!wordReadings.has(w.word)) wordReadings.set(w.word, new Set());
    wordReadings.get(w.word).add(w.reading);
    if(!seen.has(w.reading)){
      seen.add(w.reading);
      readings.push(w.reading);
    }
  }
  state._readingIndex = { readings, wordReadings };
}

// 不正解の選択肢を3つ作る。
// 1) CSVの choices 列に手作りの選択肢があればそれを優先
// 2) 足りない分は、正解に似た(編集距離が近く、文字数も近い)実在の読みから選ぶ
function pickReadingChoices(q){
  ensureReadingIndex();
  const { readings, wordReadings } = state._readingIndex;
  // 同じ表記で別の読みを持つ単語(二人=ふたり/ににん など)の読みは不正解に使わない
  const valid = wordReadings.get(q.word) || new Set([q.reading]);
  const chosen = [];
  const add = (r) => { if(r && !valid.has(r) && !chosen.includes(r)) chosen.push(r); };

  if(q.choices) q.choices.forEach(r => { if(chosen.length < 3) add(r); });

  if(chosen.length < 3){
    const scored = readings
      .filter(r => !valid.has(r) && !chosen.includes(r))
      .map(r => ({
        r,
        s: editDistance(r, q.reading) + 0.5 * Math.abs(r.length - q.reading.length) + Math.random() * 0.4
      }))
      .sort((x, y) => x.s - y.s);
    const top = scored.slice(0, 10).map(x => x.r);
    for(const r of shuffle(top)){ if(chosen.length >= 3) break; add(r); }
    for(const r of shuffle(readings)){ if(chosen.length >= 3) break; add(r); }
  }
  return chosen.slice(0, 3);
}

function buildReadingChoices(q){
  const container = document.getElementById('reading-choices');
  container.innerHTML = '';
  const options = shuffle([q.reading, ...pickReadingChoices(q)]);
  const cls = 'reading-choice' + (options.some(o => o.length >= 6) ? ' long' : '');
  for(const opt of options){
    addChoiceButton(container, opt, opt === q.reading, cls);
  }
}

// 4択でのヒント: 不正解の選択肢を2つ消して、2択にする
function useChoiceHint(){
  const wrongs = Array.from(document.querySelectorAll('#reading-choices .quiz-choice-btn'))
    .filter(b => b.dataset.correct !== '1' && !b.disabled);
  const removeCount = Math.min(2, wrongs.length - 1);
  if(removeCount > 0){
    shuffle(wrongs).slice(0, removeCount).forEach(b => {
      b.disabled = true;
      b.classList.add('removed');
    });
  }
  document.getElementById('btn-hint').disabled = true;
}

function onHintClick(){
  if(state._qMode === 'choice') useChoiceHint();
  else revealNextHintChar();
}

function updateMascotGrowth(){
  const total = state.queue.length || 1;
  const ratio = state.qIndex / total;
  const stages = ['🌱','🌿','🌼','🌸','🌳'];
  const idx = Math.min(stages.length-1, Math.floor(ratio * stages.length));
  document.getElementById('mascot-plant').textContent = stages[idx];
}

const CHECKPOINT_INTERVAL = 10;

// 1問終わるごとに呼ぶ。10問ごとに「つづける？」を挟み、最後まで来たら終了画面へ。
function proceedAfterAnswer(){
  if(state.qIndex >= state.queue.length){
    finishSession();
    return;
  }
  if(state.qIndex > 0 && state.qIndex % CHECKPOINT_INTERVAL === 0){
    showCheckpoint();
  }else{
    renderQuestion();
  }
}

function accuracyPraise(percent){
  if(percent >= 90) return 'パーフェクトに ちかいよ！すごすぎる！';
  if(percent >= 70) return 'とっても よく できました！';
  if(percent >= 50) return 'だいぶ よめるように なってきたね！';
  return 'よく がんばったね！つづけたら もっと よめるようになるよ！';
}

function showCheckpoint(){
  const attempted = state.qIndex;
  const percent = attempted > 0 ? Math.round(state.correctCount/attempted*100) : 0;
  document.getElementById('checkpoint-summary').textContent =
    `ここまで ${attempted}もん中 ${state.correctCount}もん せいかい！（せいかいりつ ${percent}%） ⭐${state.stars}こ`;
  showScreen('screen-checkpoint');
}

function finishSession(){
  const attempted = state.qIndex;
  const percent = attempted > 0 ? Math.round(state.correctCount/attempted*100) : 0;
  const praise = accuracyPraise(percent);
  document.getElementById('done-summary').textContent =
    `${attempted}もん中 ${state.correctCount}もん せいかい！（せいかいりつ ${percent}%） ⭐${state.stars}こ ゲット！\n${praise}`;
  showScreen('screen-done');
}

/* ---------------- マイク録音(音量を見て自動でストップ) ---------------- */
const SPEECH_THRESHOLD = 0.02;   // これを超えたら「話している」とみなす音量
const SILENCE_HOLD_MS = 450;     // 話した後、これだけ静かが続いたら自動ストップ
const MIN_RECORD_MS = 350;       // 誤タップ対策：最低でもこれだけは録音する
const MAX_RECORD_MS = 6000;      // 安全のための最大録音時間

async function toggleRecording(){
  if(state.isRecording){
    stopRecording();
    return;
  }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    state.mediaRecorder = mimeType ? new MediaRecorder(stream, {mimeType}) : new MediaRecorder(stream);
    state.mediaRecorder.addEventListener('dataavailable', e => {
      if(e.data.size>0) state.audioChunks.push(e.data);
    });
    state.mediaRecorder.addEventListener('stop', () => {
      stream.getTracks().forEach(t=>t.stop());
      stopVolumeWatch();
      handleRecordedAudio();
    });
    state.mediaRecorder.start();
    state.isRecording = true;
    state._recordStartedAt = Date.now();
    setMicUI(true);

    startVolumeWatch(stream);
    // 安全のため最大何秒かで自動停止
    state._autoStopTimer = setTimeout(()=>{ if(state.isRecording) stopRecording(); }, MAX_RECORD_MS);
  }catch(err){
    console.error(err);
    showFeedback('ng', 'マイクが つかえなかったよ。せっていを かくにんしてね');
  }
}

function startVolumeWatch(stream){
  state._voiceCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = state._voiceCtx.createMediaStreamSource(stream);
  const analyser = state._voiceCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);

  let hasSpoken = false;
  let silenceStartedAt = null;

  function tick(){
    if(!state.isRecording) return;
    analyser.getByteTimeDomainData(data);
    // 音量(RMS)を計算
    let sumSq = 0;
    for(let i=0;i<data.length;i++){
      const v = (data[i]-128)/128;
      sumSq += v*v;
    }
    const rms = Math.sqrt(sumSq/data.length);

    const elapsed = Date.now() - state._recordStartedAt;
    if(rms > SPEECH_THRESHOLD){
      hasSpoken = true;
      silenceStartedAt = null;
    }else if(hasSpoken && elapsed > MIN_RECORD_MS){
      if(silenceStartedAt === null) silenceStartedAt = Date.now();
      else if(Date.now() - silenceStartedAt > SILENCE_HOLD_MS){
        stopRecording();
        return;
      }
    }
    state._volumeRAF = requestAnimationFrame(tick);
  }
  state._volumeRAF = requestAnimationFrame(tick);
}

function stopVolumeWatch(){
  if(state._volumeRAF) cancelAnimationFrame(state._volumeRAF);
  state._volumeRAF = null;
  if(state._voiceCtx){
    state._voiceCtx.close().catch(()=>{});
    state._voiceCtx = null;
  }
}

function stopRecording(){
  if(state.mediaRecorder && state.mediaRecorder.state !== 'inactive'){
    state.mediaRecorder.stop();
  }
  clearTimeout(state._autoStopTimer);
  state.isRecording = false;
  setMicUI(false);
}

function setMicUI(recording){
  const btn = document.getElementById('btn-mic');
  const label = document.getElementById('mic-label');
  const vis = document.getElementById('mic-visualizer');
  btn.classList.toggle('recording', recording);
  label.textContent = recording ? 'きいているよ...' : 'タップして よんでね';
  vis.classList.toggle('hidden', !recording);
}

function blobToBase64(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function handleRecordedAudio(){
  const label = document.getElementById('mic-label');
  label.textContent = 'かんがえちゅう...';
  document.getElementById('btn-mic').disabled = true;

  try{
    const blob = new Blob(state.audioChunks, {type: state.mediaRecorder.mimeType || 'audio/webm'});
    const base64 = await blobToBase64(blob);
    const q = state.queue[state.qIndex];
    const heard = await transcribeWithFallback(base64, blob.type);
    const correct = isReadingMatch(heard, q.reading);
    if(correct){
      onCorrect();
    }else{
      onIncorrect(heard);
    }
  }catch(err){
    console.error(err);
    let msg = 'うまく はんていできなかったよ。もういちど ためしてね';
    if(err.message === 'NO_API_KEY'){
      msg = 'APIキーが せっていされていないよ。ホームの APIキーせっていに いれてね';
    } else if(err.message === 'API_400' || err.message === 'API_403'){
      msg = 'APIキーが ちがうかも。せっていを かくにんしてね';
    }
    showFeedback('ng', msg);
  }finally{
    document.getElementById('btn-mic').disabled = false;
    label.textContent = 'タップして よんでね';
  }
}

/* ---------------- ストレージ(localStorage / window.storage 両対応) ----------------
   claude.aiのartifact上ではwindow.storageを、GitHub Pagesやローカルファイルでは
   localStorageを使う。英文の発音チェックアプリと同じ方式。 */
const store = {
  async get(key){
    if(window.storage && window.storage.get){
      try{
        const res = await window.storage.get(key);
        return res ? res.value : null;
      }catch(e){ return null; }
    }
    try{ return localStorage.getItem(key); }catch(e){ return null; }
  },
  async set(key, value){
    if(window.storage && window.storage.set){
      try{ await window.storage.set(key, value); return; }catch(e){}
    }
    try{ localStorage.setItem(key, value); }catch(e){}
  }
};

/* ---------------- APIキー・モデル管理 ---------------- */
const API_KEY_STORE = 'gemini_api_key_v1';
const MODEL_STORE = 'gemini_model_v1';
const MODELS_LIST_STORE = 'gemini_models_list_v1';
let apiKey = '';
let MODEL_ID = 'gemini-3.5-flash-lite';
let availableModels = [];
// 無料枠が広めのモデルを優先する順番(古いモデルが廃止されても自動で切り替わる)
const FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash'
];

const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const keyStatus = document.getElementById('keyStatus');
const modelSelect = document.getElementById('modelSelect');
const listModelsBtn = document.getElementById('listModelsBtn');

async function loadApiKey(){
  const savedList = await store.get(MODELS_LIST_STORE);
  if(savedList){
    try{ availableModels = JSON.parse(savedList) || []; }catch(e){ availableModels = []; }
  }
  const savedModel = await store.get(MODEL_STORE);
  if(savedModel){
    MODEL_ID = savedModel;
    modelSelect.value = savedModel;
  }
  const val = await store.get(API_KEY_STORE);
  if(val){
    apiKey = val;
    apiKeyInput.value = val;
    keyStatus.textContent = '✓ APIキーが 保存されているよ';
  } else {
    keyStatus.textContent = 'APIキーが 未設定だよ。せっていすると あそべるようになるよ';
  }
}

saveKeyBtn.addEventListener('click', async () => {
  const val = apiKeyInput.value.trim();
  if(!val){
    keyStatus.textContent = 'キーが 入力されていないよ';
    return;
  }
  apiKey = val;
  await store.set(API_KEY_STORE, val);
  keyStatus.textContent = '✓ 保存したよ';
});

modelSelect.addEventListener('change', async () => {
  MODEL_ID = modelSelect.value;
  await store.set(MODEL_STORE, MODEL_ID);
});

listModelsBtn.addEventListener('click', async () => {
  const key = (apiKeyInput.value || apiKey || '').trim();
  if(!key){
    keyStatus.textContent = '先に APIキーを 入力してね';
    return;
  }
  keyStatus.textContent = 'モデル一覧を 取得中...';
  try{
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key }
    });
    if(!resp.ok){
      const t = await resp.text();
      console.error('ListModels failed:', resp.status, t);
      keyStatus.textContent = '取得に 失敗したよ (' + resp.status + ')。キーを かくにんしてね';
      return;
    }
    const data = await resp.json();
    const usable = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => (m.name || '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort();

    if(!usable.length){
      keyStatus.textContent = '使えるモデルが 見つからなかったよ';
      return;
    }

    modelSelect.innerHTML = '';
    usable.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      modelSelect.appendChild(opt);
    });

    // 新しい世代・軽量(lite)モデルを優先して並び替え
    function versionOf(id){
      const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : 0;
    }
    const candidates = usable
      .filter(id => /flash/.test(id))
      .filter(id => !/image|tts|live|audio|native|thinking|exp|preview/.test(id));

    const ranked = (candidates.length ? candidates : usable).slice().sort((a, b) => {
      const liteA = /lite/.test(a) ? 0 : 1;
      const liteB = /lite/.test(b) ? 0 : 1;
      if(liteA !== liteB) return liteA - liteB;
      const vd = versionOf(b) - versionOf(a);
      if(vd !== 0) return vd;
      return a.length - b.length;
    });

    const preferred = ranked[0];
    modelSelect.value = preferred;
    MODEL_ID = preferred;
    availableModels = ranked;
    await store.set(MODEL_STORE, MODEL_ID);
    await store.set(MODELS_LIST_STORE, JSON.stringify(ranked));
    keyStatus.textContent = `✓ ${usable.length}件 取得。「${preferred}」を えらんだよ`;
  }catch(e){
    console.error(e);
    keyStatus.textContent = '取得中に エラーが 発生したよ。通信環境を かくにんしてね';
  }
});

/* ---------------- Gemini APIで音声を書き起こし(モデル自動フォールバック付き) ----------------
   正誤の判定はGeminiにやらせず、書き起こし(ひらがな)だけをやらせて
   JS側で厳密に比較する。判定基準を自分でコントロールできるようにするため。
   選んだモデルが429(制限)/404(廃止)の場合は、他のモデルを自動で試す。 */
async function transcribeWithFallback(base64Audio, mimeType){
  if(!apiKey){
    throw new Error('NO_API_KEY');
  }
  const chain = [MODEL_ID].concat(
    availableModels.filter(m => m !== MODEL_ID),
    FALLBACK_MODELS.filter(m => m !== MODEL_ID && !availableModels.includes(m))
  ).slice(0, 5);

  let lastErr = null;
  for(let i=0; i<chain.length; i++){
    const model = chain[i];
    try{
      const heard = await callModelAudio(model, base64Audio, mimeType);
      if(model !== MODEL_ID){
        MODEL_ID = model;
        modelSelect.value = model;
        await store.set(MODEL_STORE, model);
        keyStatus.textContent = `モデルを「${model}」に 自動切替したよ(前のモデルは 制限に達したため)`;
      }
      return heard;
    }catch(e){
      lastErr = e;
      if(e.message !== 'API_429' && e.message !== 'API_404'){ throw e; }
    }
  }
  throw lastErr || new Error('API_UNKNOWN');
}

async function callModelAudio(model, base64Audio, mimeType){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const prompt = `この音声には日本語の短い単語が1つ話されています。
話されている内容を、聞こえたとおり正確にひらがなのみで書き起こしてください。
・意味を推測したり、正しい日本語に「補正」したりしないでください。聞こえた音をそのまま書いてください。
・無音、雑音のみ、または聞き取れない場合は空文字にしてください。
・カタカナ、漢字、句読点、スペースは使わず、ひらがなのみで出力してください。
以下のJSON形式のみで回答し、他の文章は一切含めないでください。
{"heard": "ひらがなでの書き起こし"}`;

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType || 'audio/webm', data: base64Audio } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const errText = await res.text();
    console.error('Gemini API error:', res.status, errText);
    throw new Error('API_' + res.status);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!text) throw new Error('API_EMPTY');
  let parsed;
  try{
    parsed = JSON.parse(text);
  }catch(e){
    const match = text.match(/\{[\s\S]*\}/);
    if(match) parsed = JSON.parse(match[0]);
    else throw e;
  }
  return (parsed.heard || '').trim();
}

/* ---------------- 読み方の厳密比較 ---------------- */
function normalizeReading(s){
  return (s || '')
    .replace(/[\s　。、!！?？「」『』]/g, '')
    .replace(/ー/g, '') // 長音記号のゆれを吸収
    .trim();
}

// レーベンシュタイン距離(編集距離)
function editDistance(a, b){
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, () => new Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0] = i;
  for(let j=0;j<=n;j++) dp[0][j] = j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      if(a[i-1] === b[j-1]) dp[i][j] = dp[i-1][j-1];
      else dp[i][j] = 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function isReadingMatch(heard, target){
  const h = normalizeReading(heard);
  const t = normalizeReading(target);
  if(!h) return false;
  if(h === t) return true;
  // 「ん」のような1文字の読みは、「うん」「んー」のように前後に音がついて
  // 聞き取られることが多いため、その文字が含まれていれば正解にする。
  if(t.length === 1) return h.includes(t);
  // 短い単語(2〜3文字)は完全一致のみ正解。誤読と聞き間違いを混同しないため厳しめにする。
  if(t.length <= 3) return false;
  // 4文字以上は、聞き取りの揺れ(促音の有無など)を1文字分だけ許容する。
  return editDistance(h, t) <= 1;
}

/* ---------------- 苦手記録(学年をまたいでlocalStorageに保存) ---------------- */
const MISTAKES_STORE = 'kanji_mistakes_v1';

async function loadMistakes(){
  const raw = await store.get(MISTAKES_STORE);
  if(raw){
    try{ state.mistakes = JSON.parse(raw) || {}; }catch(e){ state.mistakes = {}; }
  }else{
    state.mistakes = {};
  }
}

function persistMistakes(){
  store.set(MISTAKES_STORE, JSON.stringify(state.mistakes)).catch(()=>{});
}

function recordMistake(w){
  const key = mistakeKey(w);
  state.mistakes[key] = (state.mistakes[key] || 0) + 1;
  persistMistakes();
}

function reduceMistake(w){
  const key = mistakeKey(w);
  if(state.mistakes[key]){
    state.mistakes[key] -= 1;
    if(state.mistakes[key] <= 0) delete state.mistakes[key];
    persistMistakes();
  }
}

/* ---------------- ヒント(1文字ずつ表示) ---------------- */
function revealNextHintChar(){
  const q = state.queue[state.qIndex];
  if(!q) return;
  state.hintRevealCount = Math.min((state.hintRevealCount||0) + 1, q.reading.length);
  const hint = document.getElementById('reading-hint');
  const chars = q.reading.split('');
  hint.textContent = chars.map((c,i)=> i < state.hintRevealCount ? c : '？').join('');
  hint.classList.remove('hidden');
}

/* ---------------- スキップ(読みを2秒表示してから次へ) ---------------- */
function onSkip(){
  const q = state.queue[state.qIndex];
  if(!q) return;
  const hint = document.getElementById('reading-hint');
  hint.textContent = q.reading;
  hint.classList.remove('hidden');
  document.getElementById('btn-skip').disabled = true;
  document.getElementById('btn-hint').disabled = true;
  if(state._qMode !== 'voice'){
    state._quizAnswered = true;
    document.querySelectorAll('.quiz-choice-btn').forEach(b => {
      b.disabled = true;
      if(b.dataset.correct === '1') b.classList.add('correct');
    });
  }
  state.qIndex++;
  setTimeout(()=>{
    document.getElementById('btn-skip').disabled = false;
    document.getElementById('btn-hint').disabled = false;
    proceedAfterAnswer();
  }, 2000);
}

/* ---------------- 正解・不正解の処理 ---------------- */
function onCorrect(){
  const q = state.queue[state.qIndex];
  state.correctCount++;
  state.stars++;
  document.getElementById('star-count').textContent = state.stars;
  const praise = PRAISE_WORDS[Math.floor(Math.random()*PRAISE_WORDS.length)];
  showFeedback('ok', praise);
  showPraiseToast(praise);
  playChime();
  fireCelebration();
  playMascotHappy();
  // 正解の読みを2秒間表示してから次の問題へ
  const hint = document.getElementById('reading-hint');
  hint.textContent = q.reading;
  hint.classList.remove('hidden');

  // このセッション中に一度でも間違えた単語は、3〜6問後にもう一度出題する
  if(state.currentAttemptFails > 0 && !q._reinserted){
    const gap = 3 + Math.floor(Math.random()*4);
    const insertPos = Math.min(state.qIndex + 1 + gap, state.queue.length);
    state.queue.splice(insertPos, 0, Object.assign({}, q, {_reinserted:true}));
  }

  // 正解できたので苦手記録を少しやわらげる(できるようになってきたサイン)
  reduceMistake(q);

  state.qIndex++;
  setTimeout(proceedAfterAnswer, 2000);
}

function onIncorrect(heard){
  const q = state.queue[state.qIndex];
  state.currentAttemptFails++;
  recordMistake(q);
  const msg = GENTLE_WORDS[Math.floor(Math.random()*GENTLE_WORDS.length)];
  showFeedback('ng', msg);
  const shakeTarget = document.getElementById('kana-quiz').classList.contains('hidden')
    ? document.getElementById('flash-card')
    : document.getElementById('kana-quiz');
  shakeTarget.classList.remove('shake-soft'); void shakeTarget.offsetWidth; shakeTarget.classList.add('shake-soft');
  if(state.currentAttemptFails >= 2 && state._qMode !== 'choice'){
    revealNextHintChar();
  }
}

function showFeedback(type, text){
  const bubble = document.getElementById('feedback-bubble');
  bubble.textContent = text;
  bubble.className = `feedback-bubble ${type}`;
  bubble.classList.remove('hidden');
}

function showPraiseToast(text){
  const toast = document.createElement('div');
  toast.className = 'praise-toast';
  toast.textContent = text + ' 🎉';
  document.getElementById('celebration-layer').appendChild(toast);
  setTimeout(()=>toast.remove(), 1300);
}

/* ---------------- 効果音(普通のチャイム音) ---------------- */
let audioCtx;
function playChime(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = [880, 1174.66]; // A5 -> D6 のさわやかな2音
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = audioCtx.currentTime + i*0.11;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start+0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start+0.4);
    });
  }catch(e){ /* サウンド再生に失敗しても無視 */ }
}

/* ---------------- ごほうび演出(数バージョン) ---------------- */
const CELEBRATIONS = ['confetti', 'sparkle', 'petal', 'ribbon'];

const MASCOT_NORMAL_SRC = 'assets/mascot-beaver.png';
const MASCOT_HAPPY_SRC = 'assets/mascot-beaver-happy.png';
// 事前読み込みしておき、正解時に一瞬で切り替わるようにする
new Image().src = MASCOT_HAPPY_SRC;

function playMascotHappy(){
  const el = document.getElementById('mascot-beaver');
  if(!el) return;
  el.src = MASCOT_HAPPY_SRC;
  el.classList.remove('happy');
  void el.offsetWidth; // reflowでアニメ再トリガー
  el.classList.add('happy');
  clearTimeout(state._mascotRevertTimer);
  state._mascotRevertTimer = setTimeout(()=>{
    el.src = MASCOT_NORMAL_SRC;
  }, 1600);
}

function fireCelebration(){
  const type = CELEBRATIONS[Math.floor(Math.random()*CELEBRATIONS.length)];
  const layer = document.getElementById('celebration-layer');
  if(type === 'confetti') celebrateConfetti(layer);
  else if(type === 'sparkle') celebrateSparkle(layer);
  else if(type === 'petal') celebratePetal(layer);
  else celebrateRibbon(layer);
}

function celebrateConfetti(layer){
  const colors = ['#7FD1B9','#FFB6C8','#FFE29A','#A9E2FF','#3FA98A'];
  for(let i=0;i<36;i++){
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    const size = 6 + Math.random()*6;
    el.style.width = size+'px';
    el.style.height = (size*1.6)+'px';
    el.style.left = Math.random()*100+'vw';
    el.style.background = colors[Math.floor(Math.random()*colors.length)];
    const duration = 1.4 + Math.random()*1.0;
    el.style.animationDuration = duration+'s';
    el.style.animationDelay = (Math.random()*0.2)+'s';
    layer.appendChild(el);
    setTimeout(()=>el.remove(), (duration+0.3)*1000);
  }
}

function celebrateSparkle(layer){
  const emojis = ['✨','⭐','🌟','💫'];
  const cx = 50, cy = 45;
  for(let i=0;i<20;i++){
    const el = document.createElement('div');
    el.className = 'spark-star';
    el.textContent = emojis[Math.floor(Math.random()*emojis.length)];
    const angle = Math.random()*Math.PI*2;
    const dist = 80 + Math.random()*160;
    el.style.setProperty('--dx', Math.cos(angle)*dist+'px');
    el.style.setProperty('--dy', Math.sin(angle)*dist+'px');
    el.style.left = cx+'vw';
    el.style.top = cy+'vh';
    layer.appendChild(el);
    setTimeout(()=>el.remove(), 1000);
  }
}

function celebratePetal(layer){
  const emojis = ['🌸','🌷','🌼'];
  for(let i=0;i<24;i++){
    const el = document.createElement('div');
    el.className = 'petal-piece';
    el.textContent = emojis[Math.floor(Math.random()*emojis.length)];
    el.style.left = Math.random()*100+'vw';
    el.style.setProperty('--dx', (Math.random()*80-40)+'vw');
    const duration = 1.6 + Math.random()*1.0;
    el.style.animationDuration = duration+'s';
    el.style.animationDelay = (Math.random()*0.3)+'s';
    layer.appendChild(el);
    setTimeout(()=>el.remove(), (duration+0.4)*1000);
  }
}

function celebrateRibbon(layer){
  const colors = ['#7FD1B9','#FFB6C8','#FFE29A','#A9E2FF'];
  for(let i=0;i<6;i++){
    const el = document.createElement('div');
    el.className = 'ribbon-arc';
    const size = 80 + i*30;
    el.style.width = size+'px';
    el.style.height = size+'px';
    el.style.left = '50%';
    el.style.top = '42%';
    el.style.marginLeft = (-size/2)+'px';
    el.style.marginTop = (-size/2)+'px';
    el.style.borderTopColor = colors[i % colors.length];
    el.style.borderRightColor = colors[(i+1) % colors.length];
    el.style.animationDelay = (i*0.05)+'s';
    layer.appendChild(el);
    setTimeout(()=>el.remove(), 1100);
  }
}

/* ---------------- 設定の保存・読み込み(答え方 / カタカナの行) ---------------- */
const ANSWER_MODE_STORE = 'kanji_answer_mode_v1';
const KATA_ROWS_STORE = 'kanji_kata_rows_v1';

async function loadAnswerMode(){
  const v = await store.get(ANSWER_MODE_STORE);
  state.answerMode = (v === 'voice') ? 'voice' : 'choice';
  const radio = document.querySelector(`input[name="answer-mode"][value="${state.answerMode}"]`);
  if(radio) radio.checked = true;
}

async function loadKatakanaRows(){
  const raw = await store.get(KATA_ROWS_STORE);
  if(!raw) return;
  try{
    const arr = JSON.parse(raw);
    if(Array.isArray(arr)){
      state.katakanaRows = arr.filter(id => KATAKANA_ROWS.some(r => r.id === id));
    }
  }catch(e){ /* 壊れていたら初期値(全部ON)のまま */ }
}

/* ---------------- 初期化 ---------------- */
function bindEvents(){
  document.getElementById('btn-start').addEventListener('click', startSession);
  document.getElementById('btn-back').addEventListener('click', ()=>showScreen('screen-setup'));
  document.getElementById('btn-home').addEventListener('click', ()=>showScreen('screen-setup'));
  document.getElementById('btn-play-audio').addEventListener('click', ()=>{
    const q = state.queue[state.qIndex];
    if(q) speakReading(q.reading);
  });
  document.getElementById('btn-again').addEventListener('click', ()=>{ state.stars = 0; startSession(); });
  document.getElementById('btn-mic').addEventListener('click', toggleRecording);
  document.getElementById('btn-hint').addEventListener('click', onHintClick);
  document.getElementById('btn-skip').addEventListener('click', onSkip);
  document.getElementById('btn-checkpoint-continue').addEventListener('click', renderQuestion);
  document.getElementById('btn-checkpoint-stop').addEventListener('click', finishSession);
  document.querySelectorAll('input[name="answer-mode"]').forEach(r => {
    r.addEventListener('change', ()=>{
      if(!r.checked) return;
      state.answerMode = r.value;
      store.set(ANSWER_MODE_STORE, r.value);
    });
  });
  document.getElementById('reset-mistakes-btn').addEventListener('click', (e)=>{
    e.preventDefault();
    if(confirm('にがてな かんじの きろくを けしますか？')){
      state.mistakes = {};
      persistMistakes();
      renderGradeList();
    }
  });
}

(async function init(){
  bindEvents();
  const verEl = document.getElementById('app-version');
  if(verEl) verEl.textContent = APP_VERSION;
  await loadApiKey();
  await loadMistakes();
  await loadAnswerMode();
  await loadKatakanaRows();
  await loadData();
  renderGradeList();
})();
