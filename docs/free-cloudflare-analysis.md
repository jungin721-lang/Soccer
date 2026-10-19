# 무료 Cloudflare 분석 연결

이 안내는 **앱 운영자 또는 성인 보호자가 서버를 연결하는 절차**입니다. 앱을 이용하는 선수에게 Cloudflare 가입이나 API 키 입력을 요구하지 않습니다. 스마트폰에서는 Cloudflare와 기존 Netlify 프로젝트의 관리 화면을 브라우저로 엽니다.

현재 코드는 Cloudflare의 `@cf/mistralai/mistral-small-3.1-24b-instruct`로 필요한 JPEG 장면을 보내도록 구성되어 있습니다. 기존 OpenAI 키가 남아 있어도 새 앱의 분석·백그라운드 처리·정기 복구는 Cloudflare 경로를 사용하며, 오류나 한도 초과 때 OpenAI로 전환하지 않습니다.

**실제 Cloudflare 계정·토큰을 사용한 연결과 선수 영상의 식별 성능은 아직 검증하지 않았습니다.** 모의 공급자 응답과 합성 이미지를 이용한 테스트가 통과한 상태입니다. 서버 설정이나 테스트 통과를 실제 경기 분석 완료로 표시하지 않습니다.

## 스마트폰에서 서버 연결하기

1. [Cloudflare 대시보드](https://dash.cloudflare.com/)에서 운영할 계정을 확인합니다. Workers Free를 유지하고 Workers Paid나 추가 크레딧을 활성화하지 않습니다. 계정 ID를 확인합니다. 가입을 카드 없이 끝까지 완료하는 과정은 이번 작업에서 실측하지 않았습니다.
2. Cloudflare의 API 토큰 관리에서 해당 계정에 한정된 토큰을 만듭니다. 필요한 계정 권한은 **Workers AI · Read**와 **Billing · Read**입니다. Billing Read는 매 분석 묶음 전에 유료 구독이 없는지 읽기 위해 사용하며 결제 변경 권한은 요구하지 않습니다. 토큰 값은 Cloudflare와 Netlify의 비밀 설정 화면에서만 다룹니다.
3. 기존 Netlify 프로젝트의 환경변수 설정을 엽니다. **Production 컨텍스트의 Functions 범위**에 아래 두 값을 저장합니다. 앱 화면, 공개 파일, 저장소, 채팅에는 토큰을 붙여 넣지 않습니다.

   | 환경변수 이름 | 저장할 값 |
   |---|---|
   | `CLOUDFLARE_ACCOUNT_ID` | 선택한 계정의 32자리 계정 ID |
   | `CLOUDFLARE_API_TOKEN` | 위 권한을 가진 전체 비밀 토큰 |

4. 같은 Netlify 프로젝트에서 서버 함수가 포함된 새 배포를 실행합니다. 환경변수 저장과 공개 배포는 별개의 작업입니다. 정적 HTML이나 ZIP만 올리면 서버 분석이 연결되지 않습니다. 앱의 일반 이용자에게 별도 개발용 분석 코드를 전달할 필요는 없습니다.
5. 앱에 로그인하고 경기 영상 화면에서 **연결 상태 새로 확인 → 무료 분석 연결 점검**을 누릅니다. 사람이 없는 합성 이미지 한 장만 전송하며 개인 경기 영상은 사용하지 않습니다. 이 점검의 성공과 실제 경기의 선수 식별 정확도는 별개입니다. 이후 영상 권한과 장면 전송 동의를 확인한 뒤 분석합니다.

모델은 위 모델로 고정합니다. 선택 환경변수 `CLOUDFLARE_AI_MODEL`을 사용한다면 정확히 같은 이름이어야 합니다. 새 앱의 실행 환경은 `SOCCER_AI_PROVIDER=cloudflare`를 강제하므로 과거 OpenAI 설정을 무료 분석의 대체 인증으로 사용하지 않습니다. 비밀 키의 값이나 일부를 로그·오류 메시지에 출력하지 않습니다.

## 무료 한도와 과금 차단 방식

Cloudflare Workers AI의 공식 무료 할당량은 **계정 전체에서 하루 10,000 Neurons**이며 **UTC 00:00, 한국 시각 오전 9시**에 초기화됩니다. 영상 길이, 이미지 크기, 출력량에 따라 사용량이 달라져 경기 몇 개 또는 몇 분까지 가능하다고 보장할 수 없습니다. 같은 계정을 사용하는 다른 앱의 사용량도 합쳐집니다.

각 AI 요청 묶음 전에 서버가 `GET /accounts/{account_id}/subscriptions`로 계정 구독을 다시 확인합니다. 성공 응답의 전체 구독 목록이 비어 있을 때만 AI 추론을 허용합니다. 비어 있지 않은 구독 목록, 모순된 페이지 정보, 알 수 없는 응답은 `free_plan_unverified`로 중단합니다. 토큰 인증·접근 권한 오류도 별도 이유를 표시하고 추론 전에 중단합니다. 계정에 다른 종류의 구독만 있어도 보수적으로 중단할 수 있으며, 구독 목록이 있다는 이유만으로 유료 구독이라고 단정하지 않습니다.

이 조회는 공식 SDK에서 전체 목록을 반환하는 `SinglePage`로 처리하며 페이지 쿼리를 보내지 않습니다. `result_info`와 그 안의 모든 필드는 선택 사항입니다. 2026-10-19 실제 계정 조회에서는 HTTP 200, 빈 구독 목록, `{page: 1, per_page: 25}`를 확인했습니다. 없는 `count`·`total_count`를 필수로 요구하던 조건을 수정했습니다. 건수가 있다면 0이어야 하고, 명시적인 다음 페이지·양수 전체 건수·알 수 없는 필드는 계속 차단합니다. 구독 조회 401은 토큰 인증 실패, 403은 계정 접근·Billing Read 권한 문제로 구분하며 두 경우 모두 추론 전에 멈춥니다. `/api/v2/analysis/plan-check`는 로그인·동일 출처 요청만 허용하며 AI를 호출하지 않고 안전한 숫자 진단만 제공합니다.

무료 플랜이라는 확인 문구나 운영자 확인 체크만으로 이 검사를 건너뛸 수 없습니다. Cloudflare 추론 API에는 요청별로 과금을 금지하는 별도 플래그가 없어, 공식 구독 조회와 Workers Free의 할당량 제한을 사용합니다. 계정을 유료로 업그레이드하지 않습니다. 이 검사는 무료 AI 경로를 위한 것이며 Netlify 호스팅·저장·전송 플랜의 비용까지 검증한 것은 아닙니다.

무료 할당량 초과 오류 `3036`을 받으면 분석을 멈추고 다음 UTC 자정을 재확인 시각으로 보관합니다. 시간이 지났다는 이유만으로 성공 처리하지 않으며, 실제 요청 성공 뒤에만 작업을 이어 갑니다. 같은 시각에 여러 작업이 깨어나도 확인 작업 하나만 허용하고, 이전 요청의 늦은 성공이 새 한도 오류를 지우지 못하게 합니다. Cloudflare와 과거 OpenAI의 공급자 상태도 별도로 저장합니다.

| 화면이나 API 오류 | 운영자가 확인할 내용 |
|---|---|
| `missing_credentials` / `analysis_unavailable` | Production·Functions에 두 환경변수가 모두 적용됐는지 확인합니다. |
| `analysis_key_format_invalid` | 토큰에 생략 표시, 따옴표, `Bearer` 접두어 또는 중간 공백을 넣지 않았는지 비밀 설정 화면에서 확인합니다. |
| `free_plan_unverified` | Billing Read 권한, 선택한 계정, 구독 조회 가능 여부를 확인합니다. 유료 구독이 있으면 추론하지 않습니다. |
| `analysis_quota_exceeded` / 오류 `3036` | 다음 한국 시각 오전 9시 이후 재확인을 기다립니다. 유료 모델로 우회하지 않습니다. |
| `analysis_rate_limited` / 오류 `3040` | 일시적인 요청·처리 용량 부족입니다. 잠시 뒤 재시도합니다. |
| `analysis_free_plan_required` / 오류 `5035` | 유료 플랜이 필요한 요청이어서 중단했습니다. 업그레이드하여 계속하지 않습니다. |
| `analysis_credentials_rejected` / `analysis_permission_denied` | 토큰과 계정의 Workers AI 읽기 권한을 확인합니다. 토큰 값을 채팅으로 보내지 않습니다. |
| `analysis_invalid_result` | 장면 근거에 맞는 응답을 받지 못했습니다. 선수 식별이나 피드백을 만들어 완료 처리하지 않습니다. |

## 영상과 결과의 한계

AI 전송 동의 후 앱 서버가 추출한 JPEG에 경기의 다른 선수도 포함될 수 있습니다. Cloudflare는 명시적 동의 없이는 Customer Content를 모델 학습이나 자사·제3자 서비스 개선에 사용하지 않는다고 밝힙니다. 이 설명은 입력 이미지와 출력도 포함합니다. **보관 시간이 0이라는 보장은 공식 자료에서 확인하지 못했으며, 무보관·무로그라고 안내하지 않습니다.**

셔츠 색과 등번호가 확인되지 않는 장면은 식별 불가로 남겨야 합니다. 샘플 장면에서 번호를 찾는 것과 경기 전체의 모든 출현·모든 플레이를 빠짐없이 확인하는 것은 다릅니다. 정지 장면 사이의 동작, 기술 점수, 전국 순위, 성격이나 건강 상태를 추정하지 않습니다. 무료 한도로 중간에 멈추거나 영상이 흐리면 처리 범위와 빠진 범위를 그대로 알려야 합니다.

현재 검증 명령은 다음과 같습니다. 모두 합성 입력 또는 모의 외부 응답을 사용하며, 실제 계정의 무료 플랜·이미지 수 제한·경기 식별 정확도를 대신 검증하지 않습니다.

```sh
node --test --test-isolation=none tests/cloudflare-analysis.test.js tests/cloudflare-handler.test.js tests/growth-provider.test.js
```

## 확인한 공식 자료

2026-10-16 확인 기준입니다. 실제 계정 연결, 미성년자 명의 계정의 가입 가능 여부, 카드 없는 가입 절차는 별도로 확인해야 합니다. 서버 계정과 토큰은 성인 운영자가 관리합니다.

- [Workers AI 가격·무료 할당량](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI 오류 코드](https://developers.cloudflare.com/workers-ai/platform/errors/)
- [Workers AI 데이터 사용](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
- [Mistral 모델 입력·응답 스키마 — 확인한 공식 문서 리비전](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/f775315898df547b0dd049879f084523df136a33/src/content/workers-ai-models/mistral-small-3.1-24b-instruct.json)
- [계정 구독 조회 — 확인한 공식 API 스키마 리비전](https://raw.githubusercontent.com/cloudflare/api-schemas/046aa6e7cf6725795a6006148c10670db465edea/openapi.yaml)
- [Mistral 공식 모델 카드·Apache 2.0 라이선스](https://huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503/raw/main/README.md)
