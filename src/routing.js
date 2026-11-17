const fs = require("node:fs");
const path = require("node:path");

const defaultRules = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../config/routing.json"), "utf8")
);

function matches(ruleValue, value) {
  return ruleValue === "*" || ruleValue.toLowerCase() === String(value || "").toLowerCase();
}

function chooseRoute(input, rules = defaultRules) {
  const candidates = rules.filter(
    (rule) =>
      matches(rule.source, input.source) &&
      matches(rule.location, input.location) &&
      matches(rule.service_type, input.service_type)
  );

  candidates.sort((a, b) => {
    const score = (rule) =>
      ["source", "location", "service_type"].filter((key) => rule[key] !== "*").length;
    return score(b) - score(a);
  });
  return candidates[0] || null;
}

module.exports = { chooseRoute, defaultRules };
