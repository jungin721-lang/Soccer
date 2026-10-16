# 식사·수분·수면 안내 · 출처 확인 및 검토 기록

콘텐츠 버전: **2026-10-16.2**. 대상 범위는 11세 전후 유소년의 일반 생활·식사 예시입니다. 개인별 영양 처방·의료·치료식·보충제·체중 감량·칼로리 제한은 생성하지 않습니다. **공식 본문 확인과 이 앱의 독립적인 임상 검수는 별개**이며, 후자는 진행하지 않았습니다.

## 이번에 실제로 확인한 결과

2026-10-16 **15:30~15:32 한국 시간**에 공식 주소를 다시 요청했습니다. CDC 1개·AAP 본문 4개·FDA 1개에서 실제 HTML 본문을 수신했습니다. 각 본문을 읽고 아래 인용과 앱에 적용한 제한된 주장이 일치하는지 대조했습니다. HTTP 200이나 제목만 보고 확인 완료로 바꾸지 않았습니다.

이전 시도의 모든 자료가 프록시 403이었다는 기록은 이번 확인 이전의 상태입니다. 현재는 **6개 본문 확인·2개 참고 후보 미확인**으로 나눕니다. FDA 구 경로는 이번에 404를 반환했으며 공식 이동 경로와 최종 주소를 확인해 수정했습니다. 과거의 “모두 프록시 403”을 현재 상태로 반복하지 않습니다.

| 기관·문서 | 본문에 표시된 날짜 | 확인 날짜 | 실제 결과 |
|---|---|---|---|
| USDA MyPlate · [Healthy Eating for Kids](https://www.myplate.gov/life-stages/kids) | 미확인 | 2026-10-16 | 프록시 CONNECT 403 |
| CDC · [About Sleep](https://www.cdc.gov/sleep/about/index.html) | 2024-05-15 | 2026-10-16 | HTTP 200 · 본문 확인 |
| AAP · HealthyChildren · [Healthy Sleep Habits: How Many Hours Does Your Child Need?](https://www.healthychildren.org/English/healthy-living/sleep/Pages/healthy-sleep-habits-how-many-hours-does-your-child-need.aspx) | 2026-08-07 | 2026-10-16 | HTTP 200 · 본문 확인 |
| AAP · HealthyChildren · [Choose Water for Healthy Hydration](https://www.healthychildren.org/English/healthy-living/nutrition/Pages/Choose-Water-for-Healthy-Hydration.aspx) | 2024-07-26 | 2026-10-16 | HTTP 200 · 본문 확인 |
| AAP · HealthyChildren · [Healthy Food Choices for Your Family](https://www.healthychildren.org/English/ages-stages/gradeschool/nutrition/Pages/Making-Healthy-Food-Choices.aspx) | 2021-03-04 | 2026-10-16 | HTTP 200 · 본문 확인 |
| AAP · HealthyChildren · [Monitoring What Your Child Eats](https://www.healthychildren.org/English/ages-stages/gradeschool/nutrition/Pages/Monitoring-What-Your-Child-Eats.aspx) | 2009-11-03 | 2026-10-16 | HTTP 200 · 본문 확인 |
| NIH · Office of Dietary Supplements · [Calcium — Consumer](https://ods.od.nih.gov/factsheets/Calcium-Consumer/) | 미확인 | 2026-10-16 | HTTP 403 · 본문 미확인 |
| FDA · [Food Allergies](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies) | 2026-03-11 | 2026-10-16 | HTTP 200 · 본문 확인 |

CDC의 2024-05-15는 페이지 표시일, FDA의 2026-03-11은 `Content current as of`입니다. AAP 날짜는 `Last Updated`입니다. **게시일로 명시되지 않은 날짜를 최초 게시일로 추정하지 않았으며** 레지스트리의 `publishedDate`는 null입니다. AAP 응답의 HTTP Last-Modified가 요청 당일로 표시되어도 그것을 콘텐츠 개정일로 쓰지 않았습니다. 오래된 AAP 문서를 최신 지침으로 소개하지 않습니다.

## 본문과 대조한 주장

| 주장 ID | 앱에서 사용하는 범위 | 짧은 원문 근거 | 문서 |
|---|---|---|---|
| `sleep-school-age` | 6~12세 수면 권고는 하루 9~12시간입니다. | “School age 6–12 years 9–12 hours” | About Sleep |
| `sleep-consistency` | 취침·기상 시간을 일정하게 유지합니다. | “Going to bed and getting up at the same time every day.” | About Sleep |
| `screen-winddown` | 취침 최소 60분 전에 화면을 끕니다. | “turn off all screens at least 60 minutes/1 hour before bedtime.” | Healthy Sleep Habits: How Many Hours Does Your Child Need? |
| `water-meals` | 식사·간식 때 물을 제공하고 외출 때 물병을 준비합니다. | “Serve water with meals and snacks, and take those extra few minutes to pack the water bottles” | Choose Water for Healthy Hydration |
| `water-activity` | 운동 전·중·후 물을 마실 기회를 마련합니다. | “drinks water before, during and after practices or games.” | Choose Water for Healthy Hydration |
| `food-variety` | 여러 식품군의 음식을 다양하게 선택합니다. | “Your child should consume a variety of foods from the five major food groups.” | Healthy Food Choices for Your Family |
| `appetite-respect` | 아이마다 먹는 양이 달라 성인 분량을 일률적으로 요구하지 않습니다. | “the child is in the best position to decide how much to eat.” | Monitoring What Your Child Eats |
| `allergen-labels` | 포장 식품의 원재료·알레르기 표시를 확인합니다. | “requiring companies to list ingredients on packaged foods and beverages.” | Food Allergies |
| `allergen-cross-contact` | 재료 제외만으로 알레르겐 교차 접촉을 배제할 수 없습니다. | “allergen cross-contact (the inadvertent introduction of a major food allergen into a product)” | Food Allergies |

CDC 본문은 취침 전 전자기기 최소 30분을 제안합니다. 앱의 **60분** 안내는 CDC에서 가져온 숫자로 표시하지 않고, 2026-08-07 개정 표시 AAP 수면 문서의 명시적인 최소 60분 권고에 연결합니다.

AAP 수분 문서에는 연령·활동별 정량 수분 수치도 있지만 앱은 이를 11세 개인에게 고정 mL로 처방하지 않습니다. 식품군 문서의 제공 횟수·분량·칼로리도 가져오지 않습니다. 식욕 존중 문서는 2009년으로 오래되어 기본적인 대화·먹는 양 존중 원칙에만 참고합니다. FDA 자료는 미국의 표시·교차 접촉 개념 근거이지 대한민국 법률 준수나 실제 제품 안전 보증이 아닙니다.

## 확인되지 않은 자료와 대체 근거

- USDA MyPlate의 아동 페이지·홈페이지는 이번에도 중간 프록시의 CONNECT 403으로 연결이 거부되었습니다. 본문·개정일·현재 페이지 상태는 미확인입니다. 일반 식품군 원칙은 실제 읽은 AAP 문서로 대체했습니다.
- NIH ODS Calcium Consumer와 Health Professional 경로는 HTTP 403을 반환했습니다. 본문을 읽지 못했으므로 verified로 바꾸지 않았습니다. 칼슘 보충제·정량 처방의 근거로 사용하지 않습니다.
- WHO Healthy diet, NHS Eatwell Guide·Water drinks nutrition, 질병관리청 국가건강정보포털, 식품안전나라 공식 사이트도 직접 요청했지만 CONNECT 403이었습니다. 프록시 우회·임의 번역본·비공식 미러를 사용하지 않았습니다.
- FDA의 이전 `food-allergies-what-you-need-know` 경로는 404였습니다. 현재 검증한 주소는 `/food/nutrition-food-labeling-and-critical-foods/food-allergies`이며 최종 주소로 직접 재요청해 같은 본문을 받았습니다.

출처 후보가 막혔다고 동일한 권위의 확인을 했다고 주장하지 않습니다. 일반 원칙의 대체 근거를 확보했지만 국내 표시 기준·전문 영양 처방·앱 메뉴 전체의 임상 검수는 이 조회로 해결되지 않습니다.

## 앱이 만든 내용과 운영 규칙

다음은 공식 문서의 문장을 그대로 처방한 것이 아니라 버전이 있는 앱 구성입니다.

- 실제 한국 날짜 7일의 아침·점심·저녁·간식, 준비법·장보기·대안 식품 배치
- 인식한 알레르기·식품 제한을 선호보다 우선해 기본 재료에서 제외하는 규칙
- 모르는 알레르기·중증 알레르기·치료식에서 자동 메뉴를 보류하는 규칙
- 급식의 실제 메뉴를 만들지 않고 학교 식단·표시 확인과 보완으로 안내하는 규칙
- 제품·주방·조리도구·같은 제조시설의 교차 접촉은 앱이 확인할 수 없다는 한계
- 칼로리·감량·보충제·의료식·개인별 정량 수분 지시를 만들지 않는 범위

이 구조가 영양학적으로 완전하거나 알레르기 안전을 보장한다고 표시하지 않습니다. 대두 제외 때 렌틸콩까지 자동 대체에서 빼는 것은 보수적 운영 규칙이며 렌틸콩이 대두라는 뜻이 아닙니다. 인식 목록에 없는 식품 제한은 “없음”으로 처리하지 않고 메뉴를 보류합니다. 영상 실력으로 영양 결핍·건강·식습관을 추측하지 않습니다.

## 독립 검토에 제공할 체크리스트

| 검토 항목 | 현재 확보한 자료 | 독립 검토 상태 |
|---|---|---|
| 대상·표현 | 11세 일반 안내, 질환·정량 처방 제외, 위 주장별 출처 | 앱 콘텐츠에 대한 소아·영양 전문가 서명 없음 |
| 7일 메뉴 | 식품·알레르겐 데이터, 실제 생성 예시, 대안·장보기 | 개인 성장·필요량 충족 검증 없음 |
| 알레르기 | 입력 정규화·배제·미인식 보류 테스트, FDA 개념 근거 | 개별 제품·교차 접촉·국내 표시법 검증 없음 |
| 수분·회복 | AAP 원문, 정량 제외, 활동 중단·도움 요청 안내 | 증상 문구의 개별 임상 평가 없음 |
| 수면·화면 | CDC 연령표·AAP 60분 원문, 설정 시간 계산 | 실제 수면 측정·수면 질환 진단 없음 |
| 변경 추적 | 콘텐츠 버전·확인 시각·원문 인용·본문 해시 | 다음 내용 변경 시 재검토 기록 필요 |

검토 기록의 현재 값은 `individualClinicalReview: not_reviewed`, `reviewer: null`, `reviewedDate: null`입니다. 이 체크리스트를 만들었다고 검수가 진행됐거나 전문가가 참여했다고 표시하지 않습니다. 다음 검토본에는 버전·검토자 자격·범위·수정 사항·서명 날짜를 실제 이뤄진 범위에 한해 남깁니다.

## 이번 수신 본문의 추적 정보

아래 해시는 수신 당시 원본 HTML 바이트에 대한 SHA-256입니다. 원본·텍스트·요청 결과는 실행 환경의 `/tmp/next-xi-health-sources`에 보관했습니다. 공개 페이지는 이후 바뀔 수 있으며 해시가 페이지의 영구 고정이나 법적·임상 승인을 뜻하지 않습니다.

- `cdc-sleep` · 수신 2026-10-16T15:30:13.871508+09:00 · SHA-256 `fc86bbe162acc8b4619cd9643aad742a21559dd42ba0abda6923ce8625df98a1`
- `aap-sleep` · 수신 2026-10-16T15:31:16.495793+09:00 · SHA-256 `4027064ef453743b44f5b18d4fdcc20e0cf4d302ed55c61deffb792d978ca734`
- `aap-water` · 수신 2026-10-16T15:30:13.871508+09:00 · SHA-256 `448534d2c8a5b44119ea52fc926f60f500df324ebefe4fc7e632cd90686f9dd8`
- `aap-food-choices` · 수신 2026-10-16T15:32:04.410708+09:00 · SHA-256 `19fc2b4f8355f06b32aa2e30441a93902d142dd97287488c4ea2251f857ff6c7`
- `aap-appetite` · 수신 2026-10-16T15:32:04.410708+09:00 · SHA-256 `6f1fe588b8edc936f774ec85858a41ef3949d675ef12f39da95b2a44d83097f2`
- `fda-allergy` · 수신 2026-10-16T15:32:04.410708+09:00 · SHA-256 `0d551641ab3999ad6afb7b349fa3a0ca308a301bc240bf819d6f4d07fd99bf6f`
