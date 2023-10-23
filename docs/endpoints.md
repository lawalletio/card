# Card module endpoints
The card module makes available the following endpoints

<a name="top"></a>
- [Configuration endpoints](#configuration-endpoints)
    - [Initialization](#initialization)
    - [Association](#association)
    - [Activation](#activation)
- [Payment endpoints](#payment-endpoints)
    - [LUD-03 Scan](#lud-03-scan)
    - [Standard LUD-03 Callback](#standard-lud-03-callback)
    - [Extended LUD-03 Callback](#extended-lud-03-callback)
## Configuration endpoints
[Go to top](#top)
### Initialization
[Go to top](#top)
#### POST `/ntag424`
Event content:
```json
{
    "cid": <card_id>,
    "ctr": <card_tap_counter>,
    "design": {
        "name"?: <card_design_name>,
        "uuid"?: <card_design_uuid>
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
#### PATCH `/ntag424?p=<picc_data>&c=<hmac>`
Event content:
```json
{
    "otc": <one_time_code>
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
#### POST `/card`
Event content:
```json
{
    "otc": <one_time_code>,
    "delegation": {
        "conditions": <nip26_conditions>,
        "token": <nip26_sig>
    }
}
```
Example:
```bash
curl --request POST \
  --url http://localhost:3005/card/ \
  --header 'Content-Type: application/json' \
  --header 'User-Agent: insomnia/8.3.0' \
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
#### GET `/card/scan?p=<picc_data>&c=<hmac>`
Header:
```
x-lawallet-settings=<federation_id>;tokens=<token1>:<token2>:...:<tokenN>
```
Standard LUD-03 result:
```json
{
    "tag": "withdrawRequest", // type of LNURL
    "callback": string, // The URL which LN SERVICE would accept a withdrawal Lightning invoice as query parameter
    "k1": string, // Random or non-random string to identify the user's LN WALLET when using the callback URL
    "defaultDescription": string, // A default withdrawal invoice description
    "minWithdrawable": number, // Min amount (in millisatoshis) the user can withdraw from LN SERVICE, or 0
    "maxWithdrawable": number, // Max amount (in millisatoshis) the user can withdraw from LN SERVICE, or equal to minWithdrawable if the user has no choice over the amounts
}
```
Extended LUD-03 for same federation:
```json
{
    "tag": 'extendedWithdrawRequest',
    "callback": `${apiBaseUrl}/card/pay`,
    "k1": string, // Random or non-random string to identify the user's LN WALLET when using the callback URL
    "defaultDescription": 'LaWallet',
    "tokens": {
        <name1>: {
            "minWithdrawable": 0,
            "maxWithdrawable": <maxWithdrawable1>,
        },
        <name2>: {
            "minWithdrawable": 0,
            "maxWithdrawable": <maxWithdrawable2>,
        },
        ...
        <nameN>: {
            "minWithdrawable": 0,
            "maxWithdrawable": <maxWithdrawableN>,
        },
    }
}
```

### Standard LUD-03 callback
[Go to top](#top)
#### GET `/card/pay?k1=<k1_from_scan>&pr=<invoice_to_pay>`

### Extended LUD-03 callback
[Go to top](#top)
#### POST `/card`
Body
```json
{
    "k1": <k1_from_scan>,
    "tokens": {
        <name1>: <amount1>,
        <name2>: <amount2>,
        ...
        <nameN>: <amountN>,
}
```
