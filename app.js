const markets = [
  {
    title: "US election market watch",
    category: "Politics",
    probability: 47,
    volume: "$18.4M",
    change: "+2.1%",
  },
  {
    title: "Fed rate decision monitor",
    category: "Macro",
    probability: 62,
    volume: "$7.9M",
    change: "-0.6%",
  },
  {
    title: "Crypto ETF approval tracker",
    category: "Crypto",
    probability: 35,
    volume: "$4.2M",
    change: "+4.8%",
  },
];

const marketList = document.querySelector("[data-market-list]");
const updatedAt = document.querySelector("[data-updated-at]");

function renderMarkets() {
  marketList.innerHTML = markets
    .map(
      (market) => `
        <article class="market-row">
          <div>
            <p class="eyebrow">${market.category}</p>
            <h3>${market.title}</h3>
          </div>
          <div class="metric">
            <span>${market.probability}%</span>
            <small>implied</small>
          </div>
          <div class="metric">
            <span>${market.volume}</span>
            <small>volume</small>
          </div>
          <div class="change ${market.change.startsWith("+") ? "positive" : "negative"}">
            ${market.change}
          </div>
        </article>
      `,
    )
    .join("");
}

renderMarkets();
updatedAt.textContent = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
}).format(new Date());
