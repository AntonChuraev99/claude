# Шаблон промпта иконки

Английский промпт gpt-image-2 понимает точнее. Подставь `<…>` и допиши одну
строку `Concept:` на вариант.

```text
Design a mobile app icon for "<App name>", <one line: what the app does>.
Format: square 1024x1024, FULL-BLEED artwork that fills the whole canvas edge to edge. The store applies its own corner mask, so: NO rounded corners, NO border, NO frame, NO outer drop shadow, NO device mockup, NO watermark, NO extra text unless specified below.
Background: <smooth diagonal gradient from #AAAAAA (top-left) to #BBBBBB (bottom-right) | solid #AAAAAA>, with a very soft light glow behind the glyph.
Composition: ONE centered focal glyph occupying about 55% of the canvas width, generous empty margin on all sides so it survives a circle or squircle mask.
Palette strictly limited to: <brand colors in hex>, white, and <accent hex> used only as a small accent. No other colors.
Style: <premium soft semi-3D (gentle inner highlights and soft inner shading inside the shapes) | flat with minimal strokes>, bold simple shapes that stay readable at 48 pixels, polished app store quality, original mark.
Concept: <the glyph, its parts, where the accent sits and that it is clearly separate from the glyph>
```

## Что работало (прогон 2026-11-13, 6 из 6 без брака по формату)

- Фраза про маску стора убирает скругления и рамки лучше голого «no rounded corners».
- «about 55% of the canvas width» даёт глиф 55-65% — запас под круглую маску есть.
- Полуобъём («soft semi-3D, inner highlights») выглядит дороже плоского и не даёт
  внешней тени, если тень запрещена отдельно.
- Текст на иконке — только дословно в кавычках и с запретом прочего текста
  («the exact letters "AI" … Only these two letters»).
- Модель не всегда держит зазор между глифом и акцентом: «clearly separate» помогает
  не всегда — проверяй глазами.

## Концепты — с чего начать

| Форма | Пример строки Concept |
|---|---|
| Главный символ, мягкий объём | A single large chunky white checkmark, glossy and slightly puffy like soft plastic; a small gold sparkle floats clearly separate at the upper right. |
| Тактильный объект | One big soft rounded-square white checkbox, puffy like a soft-touch button, rotated about -8 degrees, with a bold accent-color checkmark that overshoots the top-right corner. |
| Один росчерк | The symbol drawn as ONE continuous flowing ribbon stroke; at the end the ribbon turns into a small burst of accent-color light. |
| Метафора продукта | Raw input (wavy scribbles) on the top half of a sheet turns into a tidy result (two checklist rows) on the bottom half. |
| Стопка / набор | Three rounded cards stacked like a deck; the front card shows one accent check and two text bars. |
| Символ + метка | The main symbol plus a small rounded accent pill with the exact letters "AI", about 1/4 of the symbol width, clearly separate. |
