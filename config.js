/* =====================================================================
   키 설정 파일 — 여기에 키를 넣으면 앱을 여는 누구나 키 입력 없이 바로 쓸 수 있습니다.

   ⚠ 이 파일을 GitHub에 올리면 키가 공개됩니다. 올리기 전에 꼭:
     1) Gemini 키: Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보 → 해당 키
        · 애플리케이션 제한: "웹사이트" → 배포 주소만 허용 (예: https://아이디.github.io/*)
        · API 제한: "Generative Language API"만 허용
     2) 결제 수단이 연결되지 않은 무료 키만 쓰기
     3) 대회가 끝나면 키 삭제(폐기)하기
   ===================================================================== */
// 대회용 공용 Gemini 키가 들어 있습니다. 누구나 볼 수 있으니 대회가 끝나면 이 키를 삭제(폐기)하세요.
window.JGCAL_KEYS = {
  geminiKey: "AQ.Ab8RN6JFLNtcOd2kNnbYfVm-DB9qnR9Dj93uCTVhNWQeqTJ69w",   // Google AI Studio에서 받은 키 (AIza...)
  neisKey: "6e1afdada50a47149f4ee77a4995c012"      // open.neis.go.kr 인증키
};
