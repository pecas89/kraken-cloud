const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PEPPERSTONE_CONFIG = {
    clientId: process.env.PEPPERSTONE_CLIENT_ID || '',
    clientSecret: process.env.PEPPERSTONE_CLIENT_SECRET || '',
    accessToken: process.env.PEPPERSTONE_ACCESS_TOKEN || '',
    refreshToken: process.env.PEPPERSTONE_REFRESH_TOKEN || '',
    accountId: parseInt(process.env.PEPPERSTONE_ACCOUNT_ID || '49442058'),
    accountNumber: parseInt(process.env.PEPPERSTONE_ACCOUNT_NUMBER || '4285238')
};

async function getLivePepperstoneAccount() {
    return new Promise((resolve, reject) => {
        const url = `https://api.spotware.com/connect/tradingaccounts?access_token=${PEPPERSTONE_CONFIG.accessToken}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.data && parsed.data.length > 0) {
                        const acc = parsed.data.find(a => a.accountNumber === PEPPERSTONE_CONFIG.accountNumber) || parsed.data[0];
                        resolve({
                            success: true,
                            broker: acc.brokerTitle,
                            accountNumber: acc.accountNumber,
                            accountId: acc.accountId,
                            balance: (acc.balance / 100).toFixed(2) + ' ' + acc.depositCurrency,
                            leverage: '1:' + acc.leverage,
                            status: acc.accountStatus,
                            type: acc.traderAccountType,
                            isLive: acc.live
                        });
                    } else {
                        resolve({ success: false, error: 'No accounts returned' });
                    }
                } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

(async () => {
    console.log('--- TEST PEPPERSTONE CLOUD CONNECTION ---');
    const res = await getLivePepperstoneAccount();
    console.log(JSON.stringify(res, null, 2));
})();
