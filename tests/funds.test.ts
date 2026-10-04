import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseFunds } from "../src/lib/domain";

const expectedCnFunds = [
  ["富国港股精选混合(QDII)人民币", "025852"],
  ["长信国防军工量化混合", "002983"],
  ["摩根标普港股通低波红利指数A", "005051"],
  ["景顺长城景颐裕利债券A", "018736"],
  ["天弘中证银行ETF联接C", "001595"],
  ["招商中证银行指数A", "161723"],
  ["中欧数字经济混合发起A", "018993"],
  ["摩根标普500指数(QDII)人民币A", "017641"]
];

describe("fund registry", () => {
  it("contains exactly the requested eight CN funds and no legacy CN fund", async () => {
    const funds = parseFunds(JSON.parse(await readFile("data/funds.json", "utf8")));
    const cnFunds = funds
      .filter(({ market }) => market === "CN")
      .map(({ name, symbol }) => [name, symbol]);
    expect(cnFunds).toEqual(expectedCnFunds);
    expect(funds.some(({ id, symbol }) => id === "cn-510300" || symbol === "510300")).toBe(false);
  });
});
