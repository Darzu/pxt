import * as workspace from "./workspace";
import * as data from "./data";
import * as pkg from "./package";
import * as core from "./core";
import * as compiler from "./compiler"
import * as workeriface from "./workeriface"

import Cloud = pxt.Cloud;
import U = pxt.Util;

let iface: workeriface.Iface
let isHalted = false
let lastCompileResult: pxtc.CompileResult;
let haltCheckRunning = false
let onHalted = Promise.resolve();
let haltHandler: () => void;
let cachedStateInfo: StateInfo
let nextBreakpoints: number[] = []
let currBreakpoint: pxtc.Breakpoint;
let lastDebugStatus: number;
let callInfos: U.Map<ExtCallInfo>;

interface ExtCallInfo {
    from: pxtc.ProcDebugInfo;
    to: pxtc.ProcDebugInfo;
    stack: number;
}


export var postMessage: (msg: pxsim.DebuggerMessage) => void;

export interface MachineState {
    registers: number[];
    stack: number[];
}

function init() {
    if (!iface) {
        if (!/^http:\/\/localhost/i.test(window.location.href) || !Cloud.localToken)
            return;
        pxt.debug('initializing debug pipe');
        iface = workeriface.makeWebSocket('ws://localhost:3233/' + Cloud.localToken + '/debug')
    }
}

export function readMemAsync(addr: number, numwords: number) {
    return workerOpAsync("mem", { addr: addr, words: numwords })
        .then(resp => resp.data as number[])
}

export function writeMemAsync(addr: number, words: number[]) {
    return workerOpAsync("wrmem", { addr: addr, words: words })
        .then(() => { })
}

let asm = ""
function callAndPush(prc: string) {
    let idx = asm.length
    asm += `
    ldr r4, .proc${idx}
    blx r4
    push {r0}
    b .next${idx}
    .balign 4
.proc${idx}:
    .word ${prc}|1
.next${idx}:
`
}

let stateProcs = [
    "pxtrt::getNumGlobals/numGlobals",
    "pxtrt::getGlobalsPtr/globalsPtr",
]


interface StateInfo {
    numGlobals: number;
    globalsPtr: number;
}

function callForStateAsync(st: MachineState) {
    if (cachedStateInfo) return Promise.resolve(cachedStateInfo)

    asm = ""

    for (let p of stateProcs) {
        callAndPush(p.replace(/\/.*/, ""))
    }

    asm += `
    bkpt 42
    @nostackcheck
`

    return compiler.assembleAsync(asm)
        .then(res => workerOpAsync("exec", { code: res.words, args: [] }))
        .then(() => snapshotAsync())
        .then(st => {
            let fields = stateProcs.map(s => s.replace(/.*\//, ""))
            fields.reverse()
            let r: any = {}
            fields.forEach((f, i) => {
                r[f] = st.stack[i]
            })
            cachedStateInfo = r
        })
        .then(() => restoreAsync(st))
        .then(() => cachedStateInfo)
}

function clearAsync() {
    isHalted = false
    lastCompileResult = null
    cachedStateInfo = null
    lastDebugStatus = null
    return Promise.resolve()
}

function coreHalted() {
    return getHwStateAsync()
        .then(st => {
            nextBreakpoints = []

            let globals: pxsim.Variables = {}
            st.globals.slice(1).forEach((v, i) => {
                let loc = lastCompileResult.procDebugInfo[0].locals[i]
                if (loc)
                    globals[loc.name] = v
                else
                    globals["?" + i] = v
            })

            let pc = st.machineState.registers[15]

            let final = () => Promise.resolve()

            let stepInBkp = lastCompileResult.procDebugInfo.filter(p => p.bkptLoc == pc)[0]
            if (stepInBkp) {
                pc = stepInBkp.codeStartLoc
                st.machineState.registers[15] = pc
                final = () => restoreAsync(st.machineState)
            }

            let bb = lastCompileResult.breakpoints
            let brkMatch = bb[0]
            let bestDelta = Infinity
            for (let b of bb) {
                let delta = pc - b.binAddr
                if (delta >= 0 && delta < bestDelta) {
                    bestDelta = delta
                    brkMatch = b
                }
            }
            currBreakpoint = brkMatch
            let msg: pxsim.DebuggerBreakpointMessage = {
                type: 'debugger',
                subtype: 'breakpoint',
                breakpointId: brkMatch.id,
                globals: globals,
                stackframes: []
            }
            postMessage(msg)
            return final()
        })
        .then(haltHandler)
}

function haltCheckAsync(): Promise<void> {
    if (isHalted)
        return Promise.delay(100).then(haltCheckAsync)
    return workerOpAsync("status")
        .then(res => {
            if (res.isHalted) {
                isHalted = true
                coreHalted()
            }
            return Promise.delay(300)
        })
        .then(haltCheckAsync)
}

function clearHalted() {
    isHalted = false
    onHalted = new Promise<void>((resolve, reject) => {
        haltHandler = resolve
    })
    if (!haltCheckRunning) {
        haltCheckRunning = true
        haltCheckAsync()
    }
}

function writeDebugStatusAsync(v: number) {
    if (v === lastDebugStatus) return Promise.resolve()
    lastDebugStatus = v
    return writeMemAsync(cachedStateInfo.globalsPtr, [v])
}

function setBreakpointsAsync(addrs: number[]) {
    return workerOpAsync("breakpoints", { addrs: addrs })
}

export function startDebugAsync() {
    return clearAsync()
        .then(() => compiler.compileAsync({ native: true }))
        .then(res => {
            lastCompileResult = res
            callInfos = {}

            let procLookup: pxtc.ProcDebugInfo[] = []
            for (let pdi of res.procDebugInfo) {
                procLookup[pdi.idx] = pdi
            }
            for (let pdi of res.procDebugInfo) {
                for (let ci of pdi.calls) {
                    callInfos[ci.addr + ""] = {
                        from: pdi,
                        to: procLookup[ci.procIndex],
                        stack: ci.stack
                    }
                }
            }

            let bb = lastCompileResult.breakpoints
            let entry = bb[1]
            for (let b of bb) {
                if (b.binAddr && b.binAddr < entry.binAddr)
                    entry = b
            }
            return setBreakpointsAsync([entry.binAddr])
        })
        .then(() => workerOpAsync("reset"))
        .then(clearHalted)
        .then(waitForHaltAsync)
        .then(res => writeDebugStatusAsync(1).then(() => res))
}

export function handleMessage(msg: pxsim.DebuggerMessage) {
    console.log("HWDBGMSG", msg)
    if (msg.type != "debugger")
        return
    let stepInto = false
    switch (msg.subtype) {
        case 'stepinto':
            stepInto = true
        case 'stepover':
            nextBreakpoints = currBreakpoint.successors.map(id => lastCompileResult.breakpoints[id].binAddr)
            resumeAsync(stepInto)
            break
    }
}

export function snapshotAsync(): Promise<MachineState> {
    return workerOpAsync("snapshot")
        .then(r => r.state as MachineState)
}

export function restoreAsync(st: MachineState): Promise<void> {
    return workerOpAsync("restore", { state: st })
        .then(() => { })
}

export function resumeAsync(into = false) {
    return Promise.resolve()
        .then(() => writeDebugStatusAsync(into ? 3 : 1))
        .then(() => setBreakpointsAsync(nextBreakpoints))
        .then(() => workerOpAsync("resume"))
        .then(clearHalted)
}

export interface HwState {
    machineState: MachineState;
    globals: number[];
}

export function waitForHaltAsync() {
    U.assert(haltCheckRunning)
    return onHalted
}

export function getHwStateAsync() {
    let res: HwState = {
        machineState: null,
        globals: []
    }
    return snapshotAsync()
        .then(v => {
            res.machineState = v
            return callForStateAsync(v)
        })
        .then(info => readMemAsync(info.globalsPtr, info.numGlobals))
        .then(g => {
            res.globals = g
            return res
        })
}

let devPath: Promise<string>;

export function workerOpAsync(op: string, arg: any = {}) {
    init()
    if (!devPath)
        devPath = iface.opAsync("list", {})
            .then((devs: any) => {
                let d0 = devs.devices[0]
                if (d0) return d0.path
                else throw new Error("No device connected")
            })
    return devPath
        .then(path => {
            arg["path"] = path;
            return iface.opAsync(op, arg)
        })
}

export function flashDeviceAsync(startAddr: number, words: number[]) {
    let cfg = {
        words: words,
        bufAddr: 0x20000000 + 0x400,
        numBuffers: 2
    }
    let asm = compiler.assembleAsync(nrfFlashAsm)
    return workerOpAsync("halt", {})
        .then(() => writeMemAsync(cfg.bufAddr - cfg.numBuffers * 4, [2, 2]))
        .then(() => asm)
        .then(res => workerOpAsync("bgexec", { code: res.words, args: [startAddr] }))
        .then(res => workerOpAsync("wrpages", cfg))
        .then(() => workerOpAsync("reset", {}))
}

export function testFlash() {
    compiler.compileAsync({ native: true })
        .then(resp => {
            console.log(resp)
            return flashDeviceAsync(resp.quickFlash.startAddr, resp.quickFlash.words)
        })
        .then(() => {
            console.log("flashed")
        })
}


/*
#define PAGE_SIZE 0x400
#define SIZE_IN_WORDS (PAGE_SIZE/4)
#define NUM_BUFFERS 2
#define PAGE_BUFFER ((uint32_t*)(0x20000000 + PAGE_SIZE))
#define CONTROL_REGS ((uint32_t volatile*)(PAGE_BUFFER - 4*NUM_BUFFERS))

void setConfig(uint32_t v) {
    NRF_NVMC->CONFIG = v;
    while (NRF_NVMC->READY == NVMC_READY_READY_Busy);    
}

void overwriteFlashPage(uint32_t* to, uint32_t* from)
{
    // Turn on flash erase enable and wait until the NVMC is ready:
    setConfig(NVMC_CONFIG_WEN_Een << NVMC_CONFIG_WEN_Pos);

    // Erase page:
    NRF_NVMC->ERASEPAGE = (uint32_t)to;
    while (NRF_NVMC->READY == NVMC_READY_READY_Busy);    

    // Turn off flash erase enable and wait until the NVMC is ready:
    setConfig(NVMC_CONFIG_WEN_Ren << NVMC_CONFIG_WEN_Pos);

    // Turn on flash write enable and wait until the NVMC is ready:
    setConfig(NVMC_CONFIG_WEN_Wen << NVMC_CONFIG_WEN_Pos);

    for(int i = 0; i <= (SIZE_IN_WORDS - 1); i++) {
        *(to + i) = *(from + i);
        while (NRF_NVMC->READY == NVMC_READY_READY_Busy);    
    }

    // Turn off flash write enable and wait until the NVMC is ready:
    setConfig(NVMC_CONFIG_WEN_Ren << NVMC_CONFIG_WEN_Pos);
}

// control values:
//   1 - ready to write
//   2 - written
//   3 - stop writing

void overwritePages(uint32_t *dst) {
  int pageIdx = 0;
  while (true) {
    while ((CONTROL_REGS[pageIdx] & 1) == 0);
    if (CONTROL_REGS[pageIdx] & 2) {
      CONTROL_REGS[pageIdx] = 2;
      break;
    }
    overwriteFlashPage(dst, PAGE_BUFFER + pageIdx * SIZE_IN_WORDS);
    CONTROL_REGS[pageIdx] = 2;
    pageIdx++;
    if (pageIdx == NUM_BUFFERS) pageIdx = 0;
  }
}
*/

let nrfFlashAsm = `
_start:
      push    {r3, r4, r5, r6, r7, lr}
      movs    r7, r0
      movs    r4, #0
      movs    r6, #2
.again:
      ldr     r3, .control
      lsls    r5, r4, #2
      adds    r5, r5, r3
      movs    r2, #1
.wait:
      ldr     r3, [r5, #0]
      tst     r3, r2
      beq     .wait
      tst     r3, r6
      bne     .ret
      ldr     r3, .data
      lsls    r1, r4, #10
      adds    r1, r1, r3
      movs    r0, r7
      subs    r4, #1
      bl      .overwriteFlashPage
      negs    r4, r4
      str     r6, [r5, #0]
      b         .again
.ret:
      str     r6, [r5, #0]
      pop     {r3, r4, r5, r6, r7, pc}

                .balign 4
.control:       .word   0x200003e0
.data:          .word   0x20000400

.setConfig:
        movs    r1, #128
        ldr     r3, .NRF_NVMC
        ldr     r2, .v504
        lsls    r1, r1, #3
        str     r0, [r3, r2]
.cfgLoop:
        ldr     r2, [r3, r1]
        cmp     r2, #0
        beq     .cfgLoop
        bx      lr

.overwriteFlashPage:
        push    {r4, r5, r6, lr}
        movs    r5, r0
        movs    r0, #2
        movs    r6, r1
        bl      .setConfig
        movs    r3, #161        ; 0xa1
        movs    r2, #128        ; 0x80
        ldr     r4, .NRF_NVMC
        lsls    r3, r3, #3
        str     r5, [r4, r3]
        lsls    r2, r2, #3
.overLoop:
        ldr     r3, [r4, r2]
        cmp     r3, #0
        beq     .overLoop
        movs    r0, #0
        bl      .setConfig
        movs    r0, #1
        bl      .setConfig
        movs    r2, #128
        lsls    r2, r2, #3
        movs    r3, #0
        movs    r1, r2
.overOuterLoop:
        ldr     r0, [r6, r3]
        str     r0, [r5, r3]
.overLoop2:
        ldr     r0, [r4, r2]
        cmp     r0, #0
        beq     .overLoop2
        adds    r3, #4
        cmp     r3, r1
        bne     .overOuterLoop
        movs    r0, #0
        bl      .setConfig
        pop     {r4, r5, r6, pc}


                .balign 4
.NRF_NVMC:      .word   0x4001e000
.v504:          .word   0x504
`

