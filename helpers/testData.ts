export type TestData = {
  title: string;
  description: string;
};

export function createTestData (): TestData {
    return {
        title: `Test Ticket ${Date.now()}`,
        description: 'Created by Playwright'
    }
}