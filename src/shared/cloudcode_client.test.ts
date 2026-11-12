import { CloudCodeClient } from './cloudcode_client';

jest.mock('./log_service', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('./official_host_version', () => ({ getOfficialIdeVersion: () => '1.0.0' }));

test.each([
    { credits: [{ creditType: 'GOOGLE_ONE_AI' }], expected: 0 },
    { credits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '500' }], expected: 500 },
    { credits: [], expected: undefined },
    { credits: undefined, expected: undefined },
    { credits: [{ creditType: 'OTHER', creditAmount: '100' }], expected: undefined },
    { credits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: 'bad' }], expected: undefined },
])('余额输入 $credits 返回 $expected', async ({ credits, expected }) => {
    const client = new CloudCodeClient();
    jest.spyOn(client, 'requestJson').mockResolvedValue({
        data: { paidTier: { id: 'paid', availableCredits: credits } },
        text: '', baseUrl: 'https://example.test', status: 200,
    });
    expect((await client.loadProjectInfo('test-token')).availableAICredits).toBe(expected);
});
