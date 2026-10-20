const human='<circle cx="100" cy="34" r="11"/><path d="M100 46v52m0-38L67 78m33-18 32 18m-32 20-20 48m20-48 22 48"/>';
const drawings={
 warm:human+'<path class="motion" d="M45 61q-15 35 5 60m100-60q15 35-5 60"/>',
 band:'<path class="support" d="M144 43v110m-14-109h30"/><circle cx="105" cy="28" r="10"/><path d="M105 40v53l-7 53m7-53-36 44m36-79 38-3"/><path class="band" d="m76 126 23 7"/><path class="motion" d="m42 135 21-2m-8-8 8 8-9 9"/><text x="14" y="170">足목 위 루프 · 지지대 잡기</text>'.replace('足','발'),
 plank:'<path class="support" d="M25 145h150"/><circle cx="49" cy="87" r="10"/><path d="m59 91 67 33 27 4m-88-31-5 33H36m90-6 4 10h22"/><path class="motion" d="m69 79 58 30"/><text x="25" y="170">팔꿈치 아래 · 무릎 지지</text>',
 deadbug:'<path class="support" d="M20 140h160"/><circle cx="40" cy="124" r="11"/><path d="M51 130h65l12-43h30m-85 42 6-52m37 53 31-26 24 23"/><text x="31" y="170">등을 대고 작은 움직임</text>',
 wall:'<path class="support" d="M65 15v132h110"/><circle cx="81" cy="39" r="10"/><path d="M79 51v41l37 16 12 35m-48-80 34 4"/><text x="30" y="170">깊게 앉지 않아요</text>',
 rope:human+'<path class="motion" d="M65 79Q7 8 80 10q102-8 55 69"/><text x="30" y="170">작게 뛰고 부드럽게 착지</text>',
 lift:human+'<circle class="ball" cx="143" cy="119" r="15"/><path class="motion" d="m143 97 0-24m-7 8 7-8 7 8"/><text x="34" y="170">한 번 차고 잡기부터</text>',
 stretch:'<path class="support" d="M150 15v138H30"/><circle cx="102" cy="39" r="10"/><path d="m105 52 9 43-52 43m52-43 19 43m-25-74 41-12"/><text x="25" y="170">반동 없이 편한 범위</text>',
 rest:'<path d="M51 51h61l-8 87H61Zm61 14h16q22 29-19 36"/><path class="motion" d="M66 31q-7-12 0-20m26 20q-7-12 0-20"/><text x="34" y="170">물과 휴식도 연습이에요</text>'
};
export function illustration(id,title){return `<svg class="exercise-art" role="img" aria-label="${title}의 기본 자세를 설명하는 개념도. 자세한 동작은 아래 글을 읽어 주세요." viewBox="0 0 200 190" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${drawings[id]||human}</g></svg>`;}
