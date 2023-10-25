# Card module endpoints

The card module makes available the following endpoints

<!-- markdownlint-disable-next-line MD033 -->
<a name="top"></a>

- [Configuration Endpoints](#configuration-endpoints)
  - [Initialization](#initialization)
  - [Association](#association)
  - [Activation](#activation)
- [Payment Endpoints](#payment-endpoints)
  - [LUD-03 Scan](#lud-03-scan)
  - [Standard LUD-03 Callback](#standard-lud-03-callback)
  - [Extended LUD-03 Callback](#extended-lud-03-callback)
- [Utility Endpoints](#utility-endpoints)
  - [Retrieve Associated `npub`](#retrieve-associated-npub)

## Configuration endpoints

[Go to top](#top)

### Initialization

[Go to top](#top)

#### `POST /ntag424`

Request body: a NOSTR event with `content` like:

```json
{
  "cid": string,       // Card id as provided by the NTAG
  "ctr": number,       // Card counter as provided by the ntag
  "design": {          // Card design (given as either a name or its UUID)
    "name": string?,   // Card design name (optional)
    "uuid": string?    // Card design UUID (optional)
  }
}
```

Example:

```bash
curl --request POST \
  --url http://localhost:3005/ntag424/ \
  --header 'Content-Type: application/json' \
  --data '{
  "id": "2601807c6d469287dc4db606b5cb05f24aa4b3b2b2d561c45cfcc0110ead92e8",
  "pubkey": "49001062a54bc52153dcc69b65927833be519104249324e462eab45d494a0c46",
  "created_at": 1698091494,
  "kind": 21111,
  "tags": [
    [
      "p",
      "75a66127dea5733b9402bddf697d0b27d7a094dfad62d22d85fd7f9eb6973a6f"
    ],
    [
      "t",
      "card-init-request"
    ]
  ],
  "content": "{\"cid\":\"f0da0000000010\",\"ctr\":0, \"design\": {\"name\": \"To the moon\"}}",
  "sig": "04653586e82c2c18e538dc9bfc587ef506dc7debcc55b47a92d8a0bb6df40787728cf340189cb047b778768f3f26ab12d6d3948f5c21d32d416a95c3f1b2ea74"
}'
```

### Association

[Go to top](#top)

#### `PATCH /ntag424`

Query parameters:

- **`p: string`:** the PICC data returned by the NTAG.
- **`c: string`:** the HMAC returned by the NTAG.

Request body: a NOSTR event with `content` like:

```json
{
  "otc": string  // One-time-code to associate to the NTAG (freeform, but it will usually be a sUUID)
}
```

Example:

```bash
curl --request PATCH \
  --url 'http://localhost:3005/ntag424/?p=EF868CC472EE41D6036984D71CD70D92&c=B0F686A9F3930E42' \
  --header 'Content-Type: application/json' \
  --header 'User-Agent: insomnia/8.3.0' \
  --data '{
  "id": "0df145d0eba75cba22147c7cede30ea868964294e12191d4152fd70499b98b8b",
  "pubkey": "49001062a54bc52153dcc69b65927833be519104249324e462eab45d494a0c46",
  "created_at": 1698091844,
  "kind": 21111,
  "tags": [
    [
      "p",
      "75a66127dea5733b9402bddf697d0b27d7a094dfad62d22d85fd7f9eb6973a6f"
    ],
    [
      "t",
      "card-init-request"
    ]
  ],
  "content": "{\"otc\":\"weirdcode\"}",
  "sig": "f07dcbea398741211929bd4e24b0b3289f64ae52baa77a03ad0ee62df4a8e2c8f1ec66e0ef64725d83c74663ca8bac227be8bafc4eba96ef4de192f946cd2488"
}'
```

### Activation

[Go to top](#top)

#### `POST /card`

Request body: a NOSTR event with `content` like:

```json
{
  "otc": string,           // One-time-code linked to the card to associate
  "delegation": {          // NIP-26 delegation data (see: https://github.com/nostr-protocol/nips/blob/master/26.md)
    "conditions": string,  // a delegation condition query string
    "token": string        // the corresponding delegation token
  }
}
```

Example:

```bash
curl --request POST \
  --url http://localhost:3005/card/ \
  --header 'Content-Type: application/json' \
  --data '{
  "id": "8fad06887f4f0475889f93e2291d0151da1157d2b7551a38afb865d47554b2e8",
  "pubkey": "49001062a54bc52153dcc69b65927833be519104249324e462eab45d494a0c46",
  "created_at": 1698091892,
  "kind": 21111,
  "tags": [
    [
      "p",
      "75a66127dea5733b9402bddf697d0b27d7a094dfad62d22d85fd7f9eb6973a6f"
    ],
    [
      "t",
      "card-activation-request"
    ]
  ],
  "content": "{\"otc\":\"weirdcode\",\"delegation\":{\"conditions\":\"kind=1112&created_at<1700762400&created_at>1698080400\",\"token\":\"dbf1ef362920cf20f9b1c1861e5491061dfb386437edf09d00f53d3f987265057d0b731e7d71d7a3eeef3c870881cca5b82647a6efa8caf04f25e0ba52606aa5\"}}",
  "sig": "285cbf75456456d7799a7450ac80b68d6ed31e833314a71609d2410016df34ef84d4c2187ae5670829909e60d0fdd73289250213e6ee90d98f7accce65317d2e"
}'
```

## Payment endpoints

[Go to top](#top)

### LUD-03 scan

[Go to top](#top)

#### `GET /card/scan`

Query parameters:

- **`p: string`:** the PICC data returned by the NTAG.
- **`c: string`:** the HMAC returned by the NTAG.

Headers:

```http
X-LaWallet-Action: extendedScan
X-LaWallet-Param: federationId=<federation_id>
X-LaWallet-Param: tokens=<token>:<token>:...:<token>
```

Where:

- **`federation_id: string`:** the ID used to identify modules in the same "federation".
- **`token: string`:** the token names the POS is interested in.

Standard [LUD-03](https://github.com/lnurl/luds/blob/luds/03.md) result (returned when the header above **IS NOT** present, or present, but with a different federation ID):

```json
{
    "tag": "withdrawRequest",               // type of LNURL
    "callback": "<API_BASE_URL>/card/pay",  // The URL which LN SERVICE would accept a withdrawal Lightning invoice as query parameter
    "k1": string,                           // Random or non-random string to identify the user's LN WALLET when using the callback URL
    "defaultDescription": "LaWallet",       // A default withdrawal invoice description
    "minWithdrawable": 0,                   // Min amount (in millisatoshis) the user can withdraw
    "maxWithdrawable": number,              // Max amount (in millisatoshis) the user can withdraw
}
```

Extended [LUD-03](https://github.com/lnurl/luds/blob/luds/03.md) result (returned when the header above **IS** present and contains the same federation ID):

```json
{
    "tag": "laWallet:withdrawRequest",      // type of LNURL
    "callback": "<API_BASE_URL>/card/pay",  // The URL which LN SERVICE would accept a withdrawal extended invoice as request body
    "k1": string,                           // Random or non-random string to identify the user's LN WALLET when using the callback URL
    "defaultDescription": "LaWallet",       // A default withdrawal invoice description
    "tokens": {                             // A list of tokens available for withdrawal (a subset of the tokens given in the extension header)
        string: {                           // The token name to provide extrema for
            "minWithdrawable": 0,           // Min amount (in the given token) the user can withdraw from LN SERVICE, or 0
            "maxWithdrawable": number       // Max amount (in the given token) the user can withdraw from LN SERVICE, or equal to minWithdrawable if the user has no choice over the amounts
        },
        ...
    }
}
```

### Standard LUD-03 callback

[Go to top](#top)

#### `GET /card/pay`

Query parameters:

- **`k1: string`:** the `k1` value sent in the scan response.
- **`pr: string`:** the payment request generated by the POS.

### Extended LUD-03 callback

[Go to top](#top)

#### `POST /card/pay`

Request body:

```json
{
  "k1": string,      // the k1 value sent in the scan response
  "npub": string,    // the recipient's NPUB
  "tokens": {        // a list of amounts to request per token name
    string: number,  // a token name mapped to a token amount to withdraw
    ...
  }
}
```

## Utility Endpoints

[Go to top](#top)

### Retrieve Associated `npub`

[Go to top](#top)

<!-- markdownlint-disable-next-line MD024 -->
#### `GET /card/scan`

Query parameters:

- **`p: string`:** the PICC data returned by the NTAG.
- **`c: string`:** the HMAC returned by the NTAG.

Headers:

```http
X-LaWallet-Action: identityQuery
X-LaWallet-Param: federationId=<federation_id>
```

Where:

- **`federation_id: string`:** the ID used to identify modules in the same "federation".

Response: a NOSTR event with the associated pubkey (as a hexadecimal string) in the event's `content`.
