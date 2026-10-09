/*
 * 베이비캠 공유용 기본 설정
 *
 * 여기에 값을 넣으면 이 주소로 접속하는 모든 기기(가족·지인 폰 포함)에 적용됩니다.
 * 앱의 [설정]에서 기기별로 입력한 값이 있으면 그 값이 우선합니다.
 *
 * ⚠ GitHub Pages 저장소는 공개이므로 여기에 넣은 API Key는 누구나 볼 수 있습니다.
 *   남이 쓰면 TURN 무료 사용량이 줄어들 수 있으니, 신경 쓰이면 비워 두고
 *   각 폰의 [설정]에서 직접 입력하세요.
 */
window.BABYCAM_CONFIG = {
  // Metered TURN (LTE·다른 망 연결용) — https://dashboard.metered.ca 에서 무료 가입 후 발급
  meteredApp: '',      // 앱 이름. 예: 'mybabycam'  (주소가 https://mybabycam.metered.live 인 경우)
  meteredApiKey: '',   // TURN 대시보드의 API Key

  // 직접 운영하는 TURN 서버가 있다면
  // 예: [{ urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }]
  turnServers: []
};
