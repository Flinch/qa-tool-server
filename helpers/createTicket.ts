import { Page } from '@playwright/test';
import { loginAsAdmin } from './auth';
import { createTestData } from './testData'

export async function createTicket(page:Page) {
    const TestData = createTestData()
    const boxOne = 'Brief summary of the issue'
    const boxTwo = 'Describe the issue in detail'
    const boxThree = 'Filename or description of'

    //access modal
    await page.getByRole('button', {name: 'New Ticket'}).first().click()
    
    //now fill the modal with relevant details
    await page.getByRole('textbox', { name: boxOne }).click();
    await page.getByRole('textbox', {name: boxOne}).fill(TestData.title)
    await page.getByRole('textbox', {name: boxTwo}).click()
    await page.getByRole('textbox', {name: boxTwo}).fill(TestData.description)
    await page.getByRole('combobox').nth(4).selectOption('Software');
    await page.getByRole('combobox').nth(5).selectOption('High');
    await page.getByRole('textbox', {name: boxThree}).click()
    await page.getByRole('textbox', {name: boxThree}).fill('No attachement here')

    //click submit
    await page.getByRole('button', {name: 'Submit Ticket'}).click()
    
    return TestData;

}