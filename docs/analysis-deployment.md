# NEXT XI: 기존 Netlify 프로젝트에 분석 서버 연결

이 문서는 **현재 구현한 소스의 설정 방법**입니다. Netlify 계정이나 AI 결제 계정에 접속해 배포한 기록은 아닙니다. 실서비스 모델 응답은 인증 정보가 없는 이 개발 환경에서 실행하지 않았습니다. API 계약·오류·기권·저장 경로는 모의 응답으로 검증했습니다.

## 연결하면 제공하는 기능

- 스마트폰에 저장한 원본에서 사용자가 고른 **최대 12초**를 JPEG 장면 최대 24장으로 추출합니다.
- 사용자가 전송에 동의하고 분석 이용 코드를 입력했을 때에만 선택 장면을 서버를 거쳐 OpenAI에 전송합니다. 원본 파일 전체를 이 분석 서버에 업로드하지 않습니다.
- 남색 11번이 확인되면 보이는 행동과 장면 시각, 다음 행동을 제공합니다. 선수를 확인하지 못하면 그 이유를 반환합니다.
- 경기 전체 평가, 능력치 점수, 전국 순위는 이 짧은 구간 분석에서 생성하지 않습니다. 스파이더맵은 평가 근거가 등록된 항목만 표시합니다.
- 원본 영상은 등록한 기기·브라우저의 IndexedDB에 남습니다. 다른 기기로 원본이 자동 동기화되지 않습니다.

## 왜 ZIP을 Drop에 다시 올리는 것만으로 연결되지 않나요?

정적 사이트 파일에는 비밀 API 키나 실행 서버를 넣지 않습니다. 이 프로젝트의 서버 함수는 `netlify/functions/analysis.mjs`이며, `lib/analysis.js`를 함께 묶어 배포해야 합니다. **정적 파일을 올리는 Netlify Drop 방식은 이 함수의 소스를 빌드하지 않습니다.** 아래처럼 기존 프로젝트에 Git 저장소를 연결하거나 Netlify CLI로 소스를 빌드해 배포해야 합니다.

## 방법 A: 기존 프로젝트에 Git 연결

1. Netlify에서 기존 프로젝트 **courageous-entremet-c8f097**을 엽니다. 다른 이름의 새 프로젝트를 만들면 이전 스마트폰 주소는 업데이트되지 않습니다.
2. 프로젝트 설정의 **Build & deploy / Continuous deployment / Repository**에서 Git 저장소를 연결하는 항목을 찾습니다. 계정 화면에 따라 메뉴 문구가 다를 수 있습니다.
3. GitHub 계정을 연결하고 **jungin721-lang/Soccer**를 선택합니다. 이 저장소를 읽을 수 있는 계정 권한이 필요합니다.
4. 배포 브랜치는 **next-xi-download-20261016**으로 선택합니다. 해당 브랜치에는 아래 소스가 모두 있어야 합니다. ZIP 파일이나 `index.html`만 있는 이전 커밋으로는 분석 서버를 빌드할 수 없습니다.

   ```text
   package.json
   scripts/export-standalone.js
   public/
   lib/analysis.js
   netlify/functions/analysis.mjs
   netlify.toml
   ```

5. `netlify.toml`에 이미 저장된 설정을 사용합니다.

   | 설정 | 값 |
   | --- | --- |
   | Base directory | 저장소 루트, 비워 둠 |
   | Build command | `npm run export` |
   | Publish directory | `.artifacts/site` |
   | Functions directory | `netlify/functions` |
   | Node | `22` |

6. 프로젝트 설정의 **Environment variables**에 다음 값을 등록합니다. API 키는 **브라우저 코드·GitHub 파일·채팅에 붙여 넣지 않습니다.** Netlify 서버 함수가 읽을 수 있는 런타임 범위(Functions)에 설정하고 Production 배포에 적용합니다.

   | 이름 | 값 |
   | --- | --- |
   | `SOCCER_AI_API_KEY` | OpenAI API 계정에서 발급한 비밀 키 |
   | `SOCCER_ANALYSIS_ACCESS_CODE` | 직접 정한 **12자 이상**의 충분히 긴 비공개 이용 코드 |
   | `SOCCER_AI_MODEL` | 선택 사항. 생략하면 `gpt-4.1-mini` |

   기존에 서버용 `OPENAI_API_KEY`가 있으면 `SOCCER_AI_API_KEY` 대신 사용할 수 있습니다. 키가 있어도 모델 호출 권한·API 이용 한도가 없으면 실제 분석은 실패하며 화면에 오류가 표시됩니다. ChatGPT 앱의 구독과 서버 API 이용은 별도입니다.

7. 기존 프로젝트의 **Deploys**에서 새 빌드를 실행합니다. 성공한 배포에 `analysis` 함수가 포함됐는지 Functions 목록이나 배포 로그에서 확인합니다.
8. 기존 프로젝트의 실제 공개 주소 뒤에 `/api/analysis`를 붙여 엽니다. 예: `https://courageous-entremet-c8f097.netlify.app/api/analysis`. 도메인을 변경했다면 프로젝트에 표시된 공개 주소를 사용합니다.

   정상 연결 상태는 아래 JSON입니다. 이 요청은 유료 모델을 호출하지 않습니다.

   ```json
   {"available":true,"reason":"ready"}
   ```

   `ready`는 필수 서버 설정이 존재한다는 의미입니다. API 키의 실제 유효성이나 모델의 분석 품질까지 검증한 결과가 아닙니다.

9. 스마트폰에서 **같은 프로젝트 주소**로 돌아와 등록한 원본 영상을 선택합니다. 남색 11번의 등번호가 분명한 구간을 고르고, 전송에 동의한 뒤 위에서 정한 분석 이용 코드를 입력해 실행합니다.

## 방법 B: 소스를 PC에서 Netlify CLI로 배포

Git 연결을 사용할 수 없다면 **소스 배포 묶음**을 압축 해제한 폴더에서 실행합니다. 정적 사이트 ZIP 안에는 필요한 서버 소스가 없습니다. PC에 Node 22 이상이 필요합니다.

```bash
npx netlify-cli login
npx netlify-cli link
npx netlify-cli deploy --build --prod
```

`link`에서는 기존 **courageous-entremet-c8f097** 프로젝트를 선택합니다. 새 프로젝트 생성을 선택하지 않습니다. API 키와 12자 이상 이용 코드는 방법 A의 환경변수 설정에서 먼저 저장합니다. 계정 로그인과 비밀 키 등록은 소유자 계정에서만 수행할 수 있으며, 이 개발 환경에는 해당 인증 정보가 없습니다.

## 증상별 확인 결과

| 화면 또는 응답 | 뜻과 조치 |
| --- | --- |
| 영상은 재생되지만 AI 미연결 | 원본 저장은 정상입니다. 서버 함수 배포와 환경변수를 연결합니다. |
| `/api/analysis`가 404 또는 웹페이지 HTML을 표시 | 정적 사이트만 배포됐거나 잘못된 프로젝트 주소입니다. 소스 빌드와 `analysis` 함수 포함 여부를 확인합니다. |
| `available:false` | 키 또는 12자 이상 이용 코드가 누락됐습니다. 환경변수를 저장한 후 다시 배포합니다. |
| 이용 코드 오류 | API 키가 아닌 `SOCCER_ANALYSIS_ACCESS_CODE` 값을 앱에 입력합니다. |
| 서버 인증 실패 | 저장한 API 키와 해당 계정의 모델 호출 권한을 확인합니다. 키 값은 화면이나 로그로 보내지 않습니다. |
| 이용 한도 도달 | OpenAI API 계정의 이용 한도·결제 상태를 조정한 뒤 다시 시도합니다. |
| 남색 11번을 확인할 수 없음 | 분석을 꾸며내지 않고 기권한 결과입니다. 등번호가 선명하고 덜 가려진 구간을 선택합니다. |
| 분석은 나오지만 스파이더맵은 관찰 대기 | 정상입니다. 짧은 정지 프레임의 관찰 결과를 전체 능력치 점수로 바꾸지 않습니다. |

현재 이용 코드는 소규모 비공개 파일럿용 접근 장치입니다. 회원별 권한·구독·사용량 제한을 제공하는 정식 로그인 시스템은 아닙니다. 이 버전에는 아동 검색·공개 랭킹·스카우터 연락 기능이 없습니다.
