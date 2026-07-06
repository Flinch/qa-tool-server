import { test, expect } from '@playwright/test';
import { createTicket } from '../../helpers/createTicket';
import { loginAsAdmin } from '../../helpers/auth';

// These @smoke tests are what the demo triggers.
// Keep them fast (< 30s total) and reliable.

const url = 'https://service-desk-roan.vercel.app';

test("@smoke login page has title", async ({page})=>{
  await page.goto('https://service-desk-roan.vercel.app');
  await expect(page.getByRole('button', {name: 'Sign in'})).toBeVisible()
})

test('@smoke user can login with valid credentials', async ({page})=>{
  await page.goto('');
  await page.getByRole('textbox', {name: 'Enter your username'}).fill('Carol')
  await page.getByRole('textbox', {name: 'Enter your password'}).fill('admin')
  await page.getByRole('button', {name: 'Sign in'}).click()
  
  await expect(page.locator('.sidebar-user-name')).toHaveText('Carol Kim')
})

test('@smoke user cannot login with invalid credentials', async ({page})=>{
  await page.goto('');
  await page.getByRole('textbox', {name: 'Enter your username'}).fill('Carol')
  await page.getByRole('textbox', {name: 'Enter your password'}).fill('employee')
  await page.getByRole('button', {name: 'Sign in'}).click()
  
  await expect(page.getByText("Invalid username or password. Please try again."))
})

//ensure admin can create ticket
test('@smoke admin can create ticket', async({page})=>{

    await page.goto(url);
    await loginAsAdmin(page);

    //create ticket
    const testData = await createTicket(page)

    //verify it
    await page.screenshot({ path: 'after-click.png', fullPage: true });
    await expect(page.getByText(testData.title)).toBeVisible();    
  
})

//ensure admin can delete tickets
test('@smoke admin can delete tickets', async({page})=>{

    await page.goto(url);
    await loginAsAdmin(page);

    //create ticket
    const testTicket = await createTicket(page)

    //delete it
    await page.getByRole('cell', {name:testTicket.title}).click()
    await page.getByRole('button', {name:"Delete Ticket"}).click()
    await page.getByTestId('confirm-delete').click();

    //verify it
    await expect(page.getByText('Ticket deleted')).toBeVisible()
    await expect(page.getByText(testTicket.title)).toHaveCount(0);

})