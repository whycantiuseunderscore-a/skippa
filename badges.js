const BADGES = Object.freeze([
  Object.freeze({ id: "pico",       name: "Pico",        days: 1,  img: "/badges/pico.png",       desc: "Your very first day; the smallest achievement you can reach." }),
  Object.freeze({ id: "nano",       name: "Nano",        days: 3,  img: "/badges/nano.png",       desc: "Three days, the habit starts forming." }),
  Object.freeze({ id: "giga",       name: "Giga",        days: 5,  img: "/badges/giga.png",       desc: "Five days. The flame's getting bigger! Keep going." }),
  Object.freeze({ id: "terra",      name: "Terra",       days: 10, img: "/badges/terra.png",      desc: "Ten days of showing up. You're getting there!" }),
  Object.freeze({ id: "gobo",       name: "Gobo",        days: 15, img: "/badges/gobo.png",       desc: "Fifteen days. You're basically unstoppable at this point." }),
  Object.freeze({ id: "scratchcat", name: "Scratch Cat", days: 25, img: "/badges/scratchcat.png", desc: "Twenty-five days. Approved by the cat himself." }),
  Object.freeze({ id: "three-eyed_scratchcat", name: "Three-eyed Scratch Cat", days: 50, img: "/badges/three-eyed_scratchcat.png", desc: "Fifty entire days?! You're nuts!" }),
  // ...
]);

module.exports = { BADGES };
