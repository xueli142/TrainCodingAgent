import { ReadTool } from './tools/read_file.js';
import { runCommandTool } from './tools/run_command.js';
import { listFilesTool } from './tools/list_file.js';
// 模拟 context
const mockContext = {
    cwd: 'D:\\_Projects\\Projects\\AI\\Agent-Learning\\icefox-agent',
    workspace: 'D:\\_Projects\\Projects\\AI\\Agent-Learning\\icefox-agent',
};

async function testReadTool() {
    console.log('=== 测试 read_file 工具 ===\n');
    
    const input = {
        path: 'package.json',  // 相对路径
    };
    
    try {
        console.log('输入参数:', input);
        console.log('上下文:', mockContext);
        console.log('当前工作目录:', process.cwd());
        console.log('\n开始调用...\n');
        
        const result = await ReadTool.run(input, mockContext);
        
        console.log('✅ 调用成功！');
        console.log('结果:', result);
        
        if (result.ok) {
            console.log('\n文件内容预览:');
            console.log('---');
            console.log(result.output.substring(0, 500));
            console.log('---');
        } else {
            console.log('❌ 调用失败:', result);
        }
    } catch (error) {
        console.error('❌ 发生异常:', error);
    }
}

async function testListFileTool() {
    console.log('\n=== 测试 list_file 工具 ===\n');
    
    // 这里假设你有 list_file 工具
    try {
        const input = {
        path: 'D:\\_Projects\\Projects\\AI\\Agent-Learning\\icefox-agent',  // 相对路径
    };
        // 如果 list_file 还没定义，可以用 Node.js 原生方法测试
        
        const files = await  listFilesTool.run(input, mockContext);
        console.log('✅ 目录列表:');
        console.log('结果',files);
    } catch (error) {
        console.error('❌ 列出目录失败:', error);
    }
}

async function testRunCommandTool() {
    console.log('\n=== 测试 run_command 工具 ===\n');
    
    const input = {
        command: process.platform === 'win32' ? 'cmd' : 'ls',
        args: process.platform === 'win32' ? ['/c', 'dir'] : ['-la'],
        cwd: 'D:\\_Projects\\Projects\\AI\\Agent-Learning\\icefox-agent',
    };
    
    try {
        console.log('输入参数:', input);
        console.log('\n开始调用...\n');
        
        const result = await runCommandTool.run(input, mockContext);
        
        console.log('✅ 调用成功！');
        console.log('结果:', result);
    } catch (error) {
        console.error('❌ 发生异常:', error);
    }
}

// 运行测试
async function runTests() {
    console.log('🔧 开始测试工具...\n');
    console.log('平台:', process.platform);
    console.log('Node 版本:', process.version);
    console.log('当前目录:', process.cwd());
    console.log('='.repeat(60));
    
    await testReadTool();
    await testListFileTool();
    await testRunCommandTool();
    
    console.log('\n✅ 所有测试完成！');
}

runTests();