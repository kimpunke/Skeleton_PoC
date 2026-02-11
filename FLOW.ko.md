# 시스템 플로우

## 구성요소
- Android 송신 앱: `app/src/main/java/com/example/mediapipepose/MainActivity.java`
- WebRTC 시그널링/서버: `webrtc-server/server.js`
- Viewer UI: `webrtc-server/public/index.html` + `webrtc-server/public/viewer.js`
- 저장소: `webrtc-server/data/app.db` sqlite, `webrtc-server/clips/` 클립

## 시작 및 시그널링
1. Android 앱이 `app/src/main/res/values/strings.xml`의 `signaling_url`을 읽어 `WebRtcStreamer`를 시작합니다.
2. `WebRtcStreamer`가 `deviceId`를 붙여 `/ws?sender`로 WebSocket을 엽니다.
3. 서버가 `/ws`를 수락하고 `senderId`를 할당한 뒤 영상 수신용 피어 연결을 만듭니다.
4. 뷰어가 `/` -> `index.html`을 로드하고 `/ws?viewer`를 열어 각 sender에 대한 offer를 받습니다.

## 비디오 스트림 플로우
1. Android 앱이 send-only 비디오 트랙을 만들고 서버로 전송합니다(offer/answer + ICE).
2. 서버가 sender 트랙을 받아 뷰어별로 복제하고 뷰어에게 offer/candidate를 보냅니다.
3. 뷰어가 그리드에 각 sender 스트림을 렌더링합니다.

## 포즈 및 낙상 라벨 플로우
1. Android 앱이 MediaPipe landmarker를 실행하고 WebSocket으로 `{"type":"pose","landmarks":[...]}`를 보냅니다.
2. 서버가 `classifyPose`로 포즈를 분류하고 `{"type":"pose-label","label":"..."}`를 sender/뷰어에 브로드캐스트합니다.
3. 뷰어가 라벨을 표시하고 `Fallen`을 낙상 신호로 처리합니다.

## 낙상 클립 플로우
1. 뷰어가 링버퍼를 유지하고 `Fallen` 시작 시 녹화, post-buffer 이후 정지합니다.
2. 뷰어가 `POST /api/fall-clips`로 WebM을 업로드하며 `X-Fall-Sender` + `X-Fall-Timestamp` 헤더를 보냅니다.
3. 서버가 `clips/fall-<sender>-<stamp>.webm`에 저장하고 `GET /api/fall-clips`로 목록, `DELETE /api/fall-clips?id=...`로 삭제합니다.
4. 클립 코멘트는 `/api/clip-comments`(GET/POST/DELETE)로 처리되며 sqlite에 저장됩니다.

## 인증 및 역할 플로우
1. 회원가입: `POST /api/signup`이 sqlite에 승인 대기 요청을 만듭니다.
2. 관리자 승인: `GET /api/admin/signup-requests`, 승인/거절은 `/api/admin/signup-requests/approve` 또는 `/api/admin/signup-requests/reject`.
3. 로그인: `POST /api/login`이 `session_id` 쿠키를 설정하며 클라이언트는 `X-Session-Id`도 보냅니다.
4. 계정: `GET /api/session`, `GET/POST /api/account`, `POST /api/account/password`, `POST /api/account/delete`.
5. 역할 관리: `GET /api/admin/users`, `POST /api/admin/users/role`.

## 명령 플로우
1. 뷰어가 WebSocket으로 `{"type":"command","senderId":"...","text":"..."}`를 보냅니다.
2. 서버가 sqlite `command_history`에 저장하고 `{"type":"command-entry"}`를 sender/뷰어에 브로드캐스트합니다.
3. 뷰어는 `{"type":"delete-command"}`로 삭제할 수 있고 서버가 역할 규칙을 적용합니다.
