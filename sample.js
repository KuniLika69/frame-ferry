globalThis.FerrySample = {
  src: "assets/book-ferry.mp4",
  name: "Книга-паром",
  start: { x: 148 / 960, y: 348 / 540 },
  finish: { x: 825 / 960, y: 348 / 540 },
  platforms: [
    {
      id: "left-stack",
      name: "левая стопка книг",
      frames: [{ time: 0, x: 75 / 960, y: 348 / 540, w: 162 / 960, h: 34 / 540 }]
    },
    {
      id: "right-stack",
      name: "правая стопка книг",
      frames: [{ time: 0, x: 734 / 960, y: 348 / 540, w: 167 / 960, h: 30 / 540 }]
    },
    {
      id: "ferry-book",
      name: "Книга-паром",
      frames: [
        { time: 0, x: 219 / 960, y: 344 / 540, w: 184 / 960, h: 25 / 540 },
        { time: .75, x: 219 / 960, y: 344 / 540, w: 184 / 960, h: 25 / 540 },
        { time: 5.25, x: 581 / 960, y: 344 / 540, w: 184 / 960, h: 25 / 540 }
      ]
    }
  ]
};
