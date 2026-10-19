export const rescueRouterAbi = [
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "MAX_AUTHORIZATION_TTL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "routeNonceUsed",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "nonce", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "route",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "depositAddress", type: "address" },
          { name: "relayer", type: "address" },
          { name: "reimbursementAmount", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "transferNonce", type: "bytes32" },
          { name: "routeNonce", type: "bytes32" }
        ]
      },
      { name: "transferV", type: "uint8" },
      { name: "transferR", type: "bytes32" },
      { name: "transferS", type: "bytes32" },
      { name: "routeV", type: "uint8" },
      { name: "routeR", type: "bytes32" },
      { name: "routeS", type: "bytes32" }
    ],
    outputs: [{ name: "forwardedAmount", type: "uint256" }]
  }
] as const;
