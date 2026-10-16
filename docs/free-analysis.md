# API 결제 없는 분석 경로의 실제 상태 — 2026-10-16

## 작동하고 검증한 기능

- 스마트폰 브라우저에서 원본을 짧은 연속 영상으로 기록합니다. 서버 업로드나 AI 호출은 없습니다.
- 영상·원본 시각 기록·설명을 ZIP으로 묶고 직접 공유할 수 있습니다.
- 채팅에서 검토한 결과를 `next-xi-feedback/v1` 파일이나 비공개 URL fragment로 앱에서 열 수 있습니다. 보관은 사용자가 선택한 기기의 IndexedDB이며 클라우드 자동 동기화와 구분합니다.
- 이 경로에서 분석은 채팅의 사용 가능 기능·한도 안에서 진행합니다. 독립적으로 항상 실행되는 웹앱 AI가 아닙니다.

## 무료 자동 분석 조사 결과

OpenAI API의 사용 가능 잔액·할당량을 코드나 새 키 발급으로 무료 복원할 수 있다고 가정하지 않습니다. 사용자에게 새 결제나 유료 요청을 실행하지 않았습니다.

공식 [SmolVLM WebGPU 예제](https://github.com/huggingface/transformers.js-examples/tree/main/smolvlm-webgpu)를 2026-10-16 확인했습니다. Transformers.js 3.7.1, `HuggingFaceTB/SmolVLM-256M-Instruct`, `AutoProcessor`와 `AutoModelForVision2Seq`, WebGPU를 사용하는 브라우저 내 추론 구현입니다. 여러 장의 로컬 이미지를 입력할 수 있습니다. [공식 라이브러리 설명](https://github.com/huggingface/transformers.js)은 WASM·WebGPU와 양자화 지원을 설명합니다. 이는 일반 기능의 근거이며 특정 모델의 양자화 파일이나 축구 분석 성능을 검증한 결과가 아닙니다.

이 환경에서 Hugging Face의 모델 설정·카드·가중치 목록 요청은 프록시의 `403 Forbidden`으로 거절됐습니다. 추가 네트워크 권한을 받은 뒤에도 동일했습니다. 따라서 정확한 다운로드 크기·가중치 라이선스·고정 리비전·실제 모델 추론·스마트폰 메모리·등번호 식별과 코칭 품질은 **미검증**입니다. 빈 연결 버튼이나 모의 결과를 무료 AI 분석 완료로 제공하지 않습니다.

기존 환경 허용 목록을 유지하면서 `huggingface.co`, `*.hf.co`, `cdn.jsdelivr.net`을 추가한 설정 초안을 저장했습니다. 도구 응답은 `status:saved`, `requires_publish:true`입니다. 저장만으로 실행 환경 네트워크가 바뀌지는 않습니다. 환경 설정 적용 후 다운로드·실제 추론·대상 영상 평가를 재개해야 합니다. 네트워크 허용 자체가 성능이나 가독성 검증은 아닙니다.

[Google의 공식 영상 예제](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Video_understanding.ipynb)는 영상 업로드와 Gemini API 분석이 가능하고 API 키가 필요함을 확인했습니다. 가격·지역·연령·데이터 이용 조건의 공식 문서 접근은 프록시 403으로 막혀 현재 무료 서비스로 추천하거나 사용자 영상을 전송하지 않았습니다.

## 아직 해결하지 못한 핵심

원본을 앱에 올리는 것만으로 남색 11번을 자동 식별·추적하고 코칭을 무료로 생성하는 기능은 완료되지 않았습니다. 공개 모델을 실제로 실행하고, 번호가 안 읽히는 장면에서 판단을 보류하는지까지 검증해야 합니다. 기존 서버 AI는 공급자 한도 제한이 있으며 무료 분할·피드백 열람이 그 한도를 해제하지 않습니다.
